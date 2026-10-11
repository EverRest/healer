import type { TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import {
  actionLimitLockKey,
  ActionLimitContentionError,
  cooldownGroupOf,
  DEFAULT_REMEDIATION_ACTION_LIMIT,
  type ActionLimitQuery,
  type CooldownGroup,
  type ReadOnlyActionLimitRepository,
} from '../domain/action-limit.js';
import { takeBoundedLock } from './advisory-lock.js';
import { excludingStep } from './step-exclusion.js';

interface CountsRow {
  readonly rate_per_window: number | null;
  readonly cooldown_seconds: number | null;
  readonly attempt_cap: number | null;
  readonly window_seconds: number;
  readonly recent: bigint;
  readonly attempts: bigint;
  readonly since: number | null;
}

/** Takes the scope's limit lock (ADR 0015), bounded; `ActionLimitContentionError` past the wait. */
export function lockActionLimit(
  tx: Prisma.TransactionClient,
  where: TenantScoped<ActionLimitQuery>,
): Promise<void> {
  const key = actionLimitLockKey(
    where.tenantId,
    where.actionKey,
    where.targetRef ?? null,
    where.fingerprint ?? null,
  );
  return takeBoundedLock(tx, key, () => new ActionLimitContentionError());
}

// `= $x` for a value, `IS NULL` for none — not `IS NOT DISTINCT FROM`, which the
// `(tenant_id, action_key, target_ref, fingerprint, evaluated_at)` index cannot serve.
function matches(column: 'target_ref' | 'fingerprint', value: string | undefined): Prisma.Sql {
  const col = Prisma.raw(`pd.${column}`);
  return value === undefined ? Prisma.sql`${col} IS NULL` : Prisma.sql`${col} = ${value}`;
}

/**
 * The configured `action_limit` row (if any) and the three counts, in one statement (R-13). Counted
 * rows are allows that were consumed or are still live (`invalidated_reason IS NULL`; consumed and
 * invalidated are mutually exclusive, `policy_decision_terminal_xor`) — a proposal that has been
 * allowed but not yet acted on counts, so N parallel proposals cannot each mint an allow before any
 * is consumed, except the evaluated step's own earlier allow (`where.step`); an invalidated, never-consumed allow (abandoned, run terminal, revoked) does not. Both the window and the elapsed time are measured from `LEAST(asOf, now())`: an
 * instant in the future (inside the skew an enforcing evaluation allows) must not shorten either. No upper bound
 * on `evaluated_at`: a caller-passed old instant must not hide later allows.
 */
export async function readActionLimit(
  tx: Prisma.TransactionClient,
  where: TenantScoped<ActionLimitQuery>,
): Promise<CooldownGroup> {
  const [row] = await tx.$queryRaw<CountsRow[]>`
    SELECT al.rate_per_window, al.cooldown_seconds, al.attempt_cap, w.window_seconds,
           c.recent, c.attempts, c.since
    FROM (SELECT 1) one
    LEFT JOIN "policy"."action_limit" al
      ON al.tenant_id = ${where.tenantId}::uuid AND al.action_key = ${where.actionKey}
    CROSS JOIN LATERAL (
      SELECT COALESCE(al.window_seconds, ${DEFAULT_REMEDIATION_ACTION_LIMIT.windowSeconds}::int) AS window_seconds
    ) w
    CROSS JOIN LATERAL (SELECT LEAST(${where.asOf}::timestamptz, now()) AS at) a
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (
               WHERE pd.evaluated_at > a.at - make_interval(secs => w.window_seconds)
             ) AS recent,
             count(*) AS attempts,
             CASE WHEN count(*) = 0 THEN NULL
                  ELSE GREATEST(0, floor(extract(epoch FROM (a.at - max(pd.evaluated_at)))))::int END AS since
      FROM "policy"."policy_decision" pd
      WHERE pd.tenant_id = ${where.tenantId}::uuid AND pd.action_key = ${where.actionKey}
        AND ${matches('target_ref', where.targetRef)} AND ${matches('fingerprint', where.fingerprint)}
        AND pd.outcome = 'allow' AND pd.invalidated_reason IS NULL
        ${excludingStep('pd', where.step)}
    ) c`;
  if (row === undefined) throw new Error('action-limit read returned no row');
  return cooldownGroupOf(
    {
      configured:
        row.rate_per_window === null
          ? null
          : {
              ratePerWindow: row.rate_per_window,
              cooldownSeconds: row.cooldown_seconds as number,
              attemptCap: row.attempt_cap as number,
            },
      windowSeconds: row.window_seconds,
      recentAllowCount: Number(row.recent),
      attemptCount: Number(row.attempts),
      secondsSinceLastAllow: row.since,
    },
    where.actionClass,
  );
}

/** Unlocked read for a dry run (`ExplainDecision`): nothing is recorded, so nothing to serialize. */
export class PrismaActionLimitRepository implements ReadOnlyActionLimitRepository {
  constructor(private readonly prisma: PrismaClient) {}

  resolve(where: TenantScoped<ActionLimitQuery>): Promise<CooldownGroup> {
    return this.prisma.$transaction((tx) => readActionLimit(tx, where));
  }
}
