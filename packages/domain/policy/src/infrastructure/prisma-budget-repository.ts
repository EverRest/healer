import { createHash } from 'node:crypto';
import { currentCorrelationId, type TenantScoped } from '@healer/shared';
import type { Prisma, PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction, type DomainEvent } from '@healer/events';
import {
  BudgetContentionError,
  type BudgetQuery,
  type BudgetRepository,
  type MarkDegradationInput,
  type MarkDegradationResult,
  type ResolvedBudget,
} from '../domain/budget-repository.js';
import { BUDGET_LOCK_WAIT_MS, MAX_EVALUATION_SKEW_MS } from '../domain/budget-bounds.js';
import { EXHAUSTED_ENTRY } from '../domain/degradation.js';
import { budgetDegradedEvent, budgetExhaustedEvent } from '../domain/events.js';
import type {
  NewRecordedDecision,
  RecordedDecision,
} from '../domain/policy-decision-repository.js';
import { resolveBudget } from './budget-aggregate.js';
import {
  assertCorrelated,
  findLiveChargedDecision,
  recordDecisionInTx,
} from './prisma-policy-decision-repository.js';

/** The producer attribution on every `budget_degradation` evidence record (001 R-06): the step
 *  that wrote it, never a caller's say-so. */
export const MARK_DEGRADATION_STEP = 'policy.mark_degradation';

/** Placeholder retention for a degradation record — it explains a reduced-context diagnosis, so
 *  it has to outlive the diagnosis it qualifies. QUESTIONS.md "002 Phase 6". */
const EVIDENCE_RETENTION_DAYS = 400;

/** How many completed agent runs a per-issue exhaustion record lists; past it the record says it
 *  was cut (`completedAgentRunsTruncated`) rather than looking complete. */
const COMPLETED_RUNS_CAP = 50;

/** The advisory-lock key serialising budget charges for one tenant. Exported so a test can hold
 *  the lock open and prove a concurrent charge waits behind it. */
export function budgetLockKey(tenantId: string): string {
  return `policy.budget:${tenantId}`;
}

/** A deterministic UUID from the step's identity, so a retried write names the same evidence row
 *  and can never mint a second one (v8-shaped: version and variant bits set). */
export function degradationEvidenceId(m: {
  readonly tenantId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly periodKey: string;
  readonly step: number;
}): string {
  const bytes = createHash('sha256')
    .update(`budget-degradation|${m.tenantId}|${m.scopeType}|${m.scopeId}|${m.periodKey}|${m.step}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The lock wait itself is bounded (BUDGET_LOCK_WAIT_MS, via `lock_timeout`), so the transaction
// budget only has to cover that plus the work: a flood queues for seconds, never for a minute of
// pooled connections.
const CHARGE_TX = { maxWait: 10_000, timeout: 30_000 } as const;

/** Postgres `lock_not_available` (55P03), however Prisma wraps it. */
function isLockTimeout(error: unknown): boolean {
  const text = `${(error as { message?: string })?.message ?? ''} ${JSON.stringify((error as { meta?: unknown })?.meta ?? '')}`;
  return text.includes('55P03') || /lock timeout/i.test(text);
}

export interface PrismaBudgetRepositoryOptions {
  /** How far an enforcing evaluation's instant may be from the database clock; `Infinity`
   *  disables the check (tests that evaluate at fixed historical instants). */
  readonly maxEvaluationSkewMs?: number;
  /** Structured warning sink for configuration that was replaced by a fail-closed value. */
  readonly log?: { warn(fields: Record<string, unknown>, message: string): void };
}

/**
 * `BudgetRepository` over Postgres (T056, T060, T064).
 *
 * `bindCharged` takes a per-tenant advisory lock *inside* the transaction that then reads the
 * aggregate and writes the decision. READ COMMITTED lets two concurrent callers both read
 * `consumed = 90`, both pass `90 + 10 <= 100`, and both commit — the lock is what makes the second
 * caller read after the first has committed its declared maximum. An advisory lock rather than a
 * `FOR UPDATE` on a row because no row is guaranteed to exist: a tenant that never configured a
 * budget runs on the fail-closed defaults and has no `budget_limit` row to lock. The wait is
 * bounded (ADR 0015).
 */
export class PrismaBudgetRepository implements BudgetRepository {
  private readonly maxSkewMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: PrismaBudgetRepositoryOptions = {},
  ) {
    this.maxSkewMs = options.maxEvaluationSkewMs ?? MAX_EVALUATION_SKEW_MS;
  }

  private surface(tenantId: string, budget: ResolvedBudget): ResolvedBudget {
    for (const warning of budget.warnings) {
      this.options.log?.warn(
        { tenantId, warning },
        'budget configuration replaced by a fail-closed value',
      );
    }
    return budget;
  }

  async resolve(where: TenantScoped<BudgetQuery>): Promise<ResolvedBudget> {
    const budget = await this.prisma.$transaction((tx) =>
      resolveBudget(tx, where.tenantId, where, this.maxSkewMs),
    );
    return this.surface(where.tenantId, budget);
  }

  /** Takes the tenant's budget lock, waiting at most `BUDGET_LOCK_WAIT_MS`. */
  private async lock(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${BUDGET_LOCK_WAIT_MS}ms`}, true)`;
    try {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${budgetLockKey(tenantId)}, 0))`;
    } catch (error) {
      if (isLockTimeout(error)) throw new BudgetContentionError();
      throw error;
    }
    await tx.$executeRaw`SELECT set_config('lock_timeout', '0', true)`;
  }

  async bindCharged(
    where: TenantScoped<BudgetQuery>,
    decide: (budget: ResolvedBudget) => TenantScoped<NewRecordedDecision>,
  ): Promise<{ readonly budget: ResolvedBudget; readonly decision: RecordedDecision }> {
    assertCorrelated();
    const result = await this.prisma
      .$transaction(async (tx) => {
        await this.lock(tx, where.tenantId);
        const budget = await resolveBudget(
          tx,
          where.tenantId,
          { ...where, enforcing: true },
          this.maxSkewMs,
        );
        const built = decide(budget);
        // A retry of the same step: return the live allowed decision already minted instead of
        // charging a second time. Under the lock, so two retries cannot both miss it.
        const existing = await findLiveChargedDecision(tx, built);
        if (existing !== null) return { budget, decision: existing };
        return { budget, decision: await recordDecisionInTx(tx, built) };
      }, CHARGE_TX)
      .catch((error: unknown) => {
        if (isLockTimeout(error)) throw new BudgetContentionError();
        throw error;
      });
    return { budget: this.surface(where.tenantId, result.budget), decision: result.decision };
  }

  async releaseAbandonedCharges(
    where: TenantScoped<{ readonly olderThan: Date }>,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, where.tenantId);
      // Allowed, never consumed, no agent run at all, older than the cutoff: the step never
      // started, so nothing will ever replace the charge with an actual cost. Only
      // `invalidated_reason` changes, which the append-only trigger permits from null.
      return tx.$executeRaw`
        UPDATE "policy"."policy_decision" pd
        SET invalidated_reason = 'charge_abandoned'
        WHERE pd.tenant_id = ${where.tenantId}::uuid AND pd.outcome = 'allow'
          AND pd.invalidated_reason IS NULL AND pd.consumed_at IS NULL
          AND pd.evaluated_at < ${where.olderThan}::timestamptz
          AND COALESCE((pd.budget_state->>'reservedSpend')::numeric, 0) > 0
          AND NOT EXISTS (SELECT 1 FROM "agent"."agent_run" ar
                          WHERE ar.tenant_id = pd.tenant_id AND ar.policy_decision_id = pd.id)`;
    }, CHARGE_TX);
  }

  async markDegradation(where: TenantScoped<MarkDegradationInput>): Promise<MarkDegradationResult> {
    assertCorrelated();
    const evidenceId = degradationEvidenceId(where);
    return this.prisma.$transaction(async (tx) => {
      // The mark is the claim. `ON CONFLICT DO NOTHING` is an insert-or-skip, not a read-then-
      // write: a concurrent writer of the same key blocks on the unique index until the first
      // commits, then skips — so exactly one transaction goes on to write the evidence record.
      const claimed = await tx.$executeRaw`
        INSERT INTO "policy"."budget_degradation_mark"
          (tenant_id, scope_type, scope_id, period_key, step, evidence_id, marked_at)
        VALUES (${where.tenantId}::uuid, ${where.scopeType}::"policy"."budget_scope_type",
                ${where.scopeId}::uuid, ${where.periodKey}, ${where.step},
                ${evidenceId}::uuid, now())
        ON CONFLICT DO NOTHING`;
      if (claimed === 0) {
        const [existing] = await tx.$queryRaw<{ evidence_id: string }[]>`
          SELECT evidence_id::text AS evidence_id FROM "policy"."budget_degradation_mark"
          WHERE tenant_id = ${where.tenantId}::uuid AND scope_type = ${where.scopeType}::"policy"."budget_scope_type"
            AND scope_id = ${where.scopeId}::uuid AND period_key = ${where.periodKey} AND step = ${where.step}`;
        return { marked: false, evidenceId: existing?.evidence_id ?? evidenceId };
      }

      const completed =
        where.entryApplied === EXHAUSTED_ENTRY && where.scopeType === 'issue'
          ? await tx.$queryRaw<{ id: string; agent_kind: string; outcome: string }[]>`
              SELECT id::text AS id, agent_kind::text AS agent_kind, outcome FROM "agent"."agent_run"
              WHERE tenant_id = ${where.tenantId}::uuid AND issue_id = ${where.scopeId}::uuid
              ORDER BY started_at LIMIT ${COMPLETED_RUNS_CAP + 1}`
          : [];

      // The deliverable (FR-012, R-12): an evidence record a reader can find a year later without
      // a metrics dashboard. Structured fields only — no collected content has a route in.
      await tx.evidence.create({
        data: {
          id: evidenceId,
          tenantId: where.tenantId,
          issueId: where.issueId,
          type: 'budget_degradation',
          sourceSystem: 'healer.policy',
          sourceRef: `budget:${where.scopeType}:${where.scopeId}:${where.periodKey}:${where.step}`,
          sourceLabel: `Budget step ${where.step}: ${where.entryApplied}`,
          excerpt: null,
          excerptTruncated: false,
          payload: {
            kind: 'budget_degradation',
            scopeType: where.scopeType,
            scopeId: where.scopeId,
            periodKey: where.periodKey,
            step: where.step,
            entryApplied: where.entryApplied,
            dimension: where.dimension,
            consumed: where.consumed,
            limit: where.limit,
            ...(completed.length > COMPLETED_RUNS_CAP ? { completedAgentRunsTruncated: true } : {}),
            ...(completed.length > 0
              ? {
                  completedAgentRuns: completed.slice(0, COMPLETED_RUNS_CAP).map((r) => ({
                    agentRunId: r.id,
                    agentKind: r.agent_kind,
                    outcome: r.outcome,
                  })),
                }
              : {}),
          },
          producedByStep: MARK_DEGRADATION_STEP,
          observedAt: where.observedAt,
          expiresAt: new Date(where.observedAt.getTime() + EVIDENCE_RETENTION_DAYS * 86_400_000),
        },
      });

      const outbox = new PrismaOutboxTransaction(tx);
      // Mirrors 001's `EvidenceRecorded` (packages/domain/evidence/src/domain/events.ts): this
      // package takes no dependency on another domain package, and a record that bypassed the
      // timeline's feed would be an evidence row 001's consumers never hear of.
      const recorded: DomainEvent = {
        name: 'EvidenceRecorded',
        tenantId: where.tenantId,
        subjectId: where.issueId,
        correlationId: correlationOf(),
        payload: {
          evidenceId,
          type: 'budget_degradation',
          producedByStep: MARK_DEGRADATION_STEP,
        },
      };
      await enqueue(outbox, recorded);
      const scope = { scopeType: where.scopeType, scopeId: where.scopeId } as const;
      await enqueue(
        outbox,
        where.entryApplied === EXHAUSTED_ENTRY
          ? budgetExhaustedEvent(where.tenantId, {
              scope,
              periodKey: where.periodKey,
              consumed: where.consumed,
              limit: where.limit,
            })
          : budgetDegradedEvent(where.tenantId, {
              scope,
              periodKey: where.periodKey,
              step: where.step,
              entryApplied: where.entryApplied,
              evidenceId,
            }),
      );
      return { marked: true, evidenceId };
    });
  }
}

function correlationOf(): string {
  const id = currentCorrelationId();
  if (id === undefined) throw new Error('markDegradation must run inside a correlated scope');
  return id;
}
