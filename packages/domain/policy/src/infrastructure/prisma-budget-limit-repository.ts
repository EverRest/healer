import { randomUUID } from 'node:crypto';
import type { TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import {
  assertWithinBudgetBounds,
  BUDGET_DEFAULTS,
  type BudgetPeriod,
} from '../domain/budget-bounds.js';
import { effectiveLimit, normaliseThresholds } from '../domain/budget-limits.js';
import type {
  BudgetLimit,
  BudgetLimitRepository,
  PutBudgetLimit,
} from '../domain/budget-repository.js';
import { loadLimits } from './budget-aggregate.js';
import { recordAuditEntry } from './record-audit-entry.js';

interface LimitRow {
  scope_type: 'issue' | 'tenant';
  period: BudgetPeriod;
  spend_limit: number;
  time_limit_ms: number;
  soft_threshold_pcts: number[] | null;
  escalation_attempt_cap: number;
  updated_by: string;
}

// A NULL threshold array is "unset", and what is *enforced* for it is the product default —
// reporting it as empty would tell a reader there are no soft steps when there are three.
const toDomain = (r: LimitRow): BudgetLimit => ({
  scopeType: r.scope_type,
  period: r.period,
  spendLimit: r.spend_limit,
  timeLimitMs: r.time_limit_ms,
  softThresholdPcts: normaliseThresholds(r.soft_threshold_pcts),
  escalationAttemptCap: r.escalation_attempt_cap,
  updatedBy: r.updated_by,
});

/** `policy.budget_limit` (T057, FR-011). `put` takes a per-tenant configuration lock, reads the
 *  limit **in force** (the stored row, else 012's `tenant_budget`, else the product default),
 *  merges the caller's fields over it, refuses a merged result outside the product bounds, upserts
 *  and writes the audit entry — all in one transaction, so a concurrent write cannot be lost and
 *  the entry's "before" cannot be stale (FR-020). Only the tenant-wide row and the per-issue
 *  default are writable through the API — a per-issue override row, if one exists, is left alone. */
export class PrismaBudgetLimitRepository implements BudgetLimitRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(where: TenantScoped<object>): Promise<readonly BudgetLimit[]> {
    const rows = await this.prisma.$queryRaw<LimitRow[]>`
      SELECT scope_type::text AS scope_type, period::text AS period,
             spend_limit::float8 AS spend_limit, time_limit_ms, soft_threshold_pcts,
             escalation_attempt_cap, updated_by
      FROM "policy"."budget_limit"
      WHERE tenant_id = ${where.tenantId}::uuid AND scope_id IS NULL
      ORDER BY scope_type, period`;
    return rows.map(toDomain);
  }

  async put(where: TenantScoped<PutBudgetLimit>): Promise<{ readonly before: BudgetLimit | null }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`policy.budget_config:${where.tenantId}`}, 0))`;
      const { rows, tenantBudgets } = await loadLimits(tx, where.tenantId, undefined);
      const kind =
        where.scopeType === 'issue'
          ? ({ scopeType: 'issue' } as const)
          : ({ scopeType: 'tenant', period: where.period as 'day' | 'month' } as const);
      const inForce = effectiveLimit(kind, rows, tenantBudgets);
      const before: BudgetLimit = {
        scopeType: where.scopeType,
        period: where.period,
        spendLimit: inForce.spendLimit,
        timeLimitMs: inForce.timeLimitMs,
        softThresholdPcts: inForce.softThresholdPcts,
        escalationAttemptCap: inForce.escalationAttemptCap ?? BUDGET_DEFAULTS.escalationAttemptCap,
        updatedBy: 'in force',
      };
      const after: BudgetLimit = {
        ...before,
        spendLimit: where.spendLimit ?? before.spendLimit,
        timeLimitMs: where.timeLimitMs ?? before.timeLimitMs,
        softThresholdPcts:
          where.softThresholdPcts === undefined
            ? before.softThresholdPcts
            : normaliseThresholds(where.softThresholdPcts),
        escalationAttemptCap: where.escalationAttemptCap ?? before.escalationAttemptCap,
        updatedBy: where.updatedBy,
      };
      // The merged result is what lands, so the merged result is what is bounded (FR-021): an
      // inherited 012 limit above a product bound cannot be re-written by a partial PUT either.
      assertWithinBudgetBounds({
        period: where.period,
        spendLimit: after.spendLimit,
        timeLimitMs: after.timeLimitMs,
        escalationAttemptCap: after.escalationAttemptCap,
        softThresholdPcts: after.softThresholdPcts,
      });

      const [written] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "policy"."budget_limit"
          (id, tenant_id, scope_type, scope_id, period, spend_limit, time_limit_ms,
           soft_threshold_pcts, escalation_attempt_cap, updated_at, updated_by)
        VALUES (${randomUUID()}::uuid, ${where.tenantId}::uuid,
                ${where.scopeType}::"policy"."budget_scope_type", NULL,
                ${where.period}::"policy"."budget_limit_period", ${after.spendLimit},
                ${after.timeLimitMs}, ${[...after.softThresholdPcts]}::int[],
                ${after.escalationAttemptCap}, now(), ${where.updatedBy})
        -- The conflict target is the migration's unique-index expression, spelled with the literal
        -- nil UUID: a bind parameter does not match an index expression.
        ON CONFLICT (tenant_id, scope_type, (COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)), period)
        DO UPDATE SET spend_limit = EXCLUDED.spend_limit, time_limit_ms = EXCLUDED.time_limit_ms,
                      soft_threshold_pcts = EXCLUDED.soft_threshold_pcts,
                      escalation_attempt_cap = EXCLUDED.escalation_attempt_cap,
                      updated_at = now(), updated_by = EXCLUDED.updated_by
        RETURNING id::text AS id`;
      if (written === undefined) throw new Error('budget_limit upsert returned no row');
      await recordAuditEntry(tx, where.auditEntryFor(before, after, written.id));
      return { before };
    });
  }
}
