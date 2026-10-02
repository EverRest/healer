import { BUDGET_DEFAULTS, type BudgetPeriod } from './budget-bounds.js';
import { DEGRADATION_ORDER } from './degradation.js';

// T057 (FR-011, R-10): which limit applies to a scope. Pure — the rows are inputs.

/** A `policy.budget_limit` row. `scopeId` is null for the tenant-wide row and for the per-issue
 *  default, and an issue id for a per-issue override. */
export interface LimitRow {
  readonly scopeType: 'issue' | 'tenant';
  readonly scopeId: string | null;
  readonly period: BudgetPeriod;
  readonly spendLimit: number;
  readonly timeLimitMs: number;
  readonly softThresholdPcts: readonly number[] | null;
  readonly escalationAttemptCap: number;
}

/** 012's `tenant.tenant_budget` row — inherited, not converted. `timeLimit` is read as
 *  milliseconds (012 leaves the unit unstated; QUESTIONS.md "002 Phase 6"). */
export interface TenantBudgetRow {
  readonly period: 'day' | 'month';
  readonly spendLimit: number;
  readonly timeLimitMs: number;
  /** `tenant_budget.soft_threshold_pcts` is nullable; null is "unset". */
  readonly softThresholdPcts: readonly number[] | null;
  readonly degradationOrder: readonly string[];
}

export interface EffectiveLimit {
  readonly spendLimit: number;
  readonly timeLimitMs: number;
  readonly softThresholdPcts: readonly number[];
  /** Null when the limit comes from 012's `tenant_budget` or the default, neither of which
   *  carries a cap. */
  readonly escalationAttemptCap: number | null;
}

/** Sorted, distinct integers in 1..99. `null` is "unset" and takes the product default; an
 *  explicit empty list means no soft steps at all. */
export function normaliseThresholds(pcts: readonly number[] | null | undefined): number[] {
  if (pcts === null || pcts === undefined) return [...BUDGET_DEFAULTS.softThresholdPcts];
  return [...new Set(pcts.filter((p) => Number.isInteger(p) && p >= 1 && p <= 99))].sort(
    (a, b) => a - b,
  );
}

const fromRow = (r: LimitRow): EffectiveLimit => ({
  spendLimit: r.spendLimit,
  timeLimitMs: r.timeLimitMs,
  softThresholdPcts: normaliseThresholds(r.softThresholdPcts),
  escalationAttemptCap: r.escalationAttemptCap,
});

/**
 * Precedence, most specific first. Issue: the issue's own row, the per-issue default row, the
 * product default. Tenant period: a `budget_limit` row, 012's `tenant_budget` row, the product
 * default. There is no path to "no limit" (FR-021: every unset value fails closed).
 */
export function effectiveLimit(
  kind:
    | { readonly scopeType: 'issue' }
    | { readonly scopeType: 'tenant'; readonly period: 'day' | 'month' },
  rows: readonly LimitRow[],
  tenantBudgets: readonly TenantBudgetRow[],
  issueId?: string,
): EffectiveLimit {
  if (kind.scopeType === 'issue') {
    const issueRows = rows.filter((r) => r.scopeType === 'issue');
    const own = issueId === undefined ? undefined : issueRows.find((r) => r.scopeId === issueId);
    const row = own ?? issueRows.find((r) => r.scopeId === null);
    if (row) return fromRow(row);
    return {
      spendLimit: BUDGET_DEFAULTS.spendLimit.issue,
      timeLimitMs: BUDGET_DEFAULTS.timeLimitMs.issue,
      softThresholdPcts: [...BUDGET_DEFAULTS.softThresholdPcts],
      escalationAttemptCap: null,
    };
  }
  const row = rows.find(
    (r) => r.scopeType === 'tenant' && r.scopeId === null && r.period === kind.period,
  );
  if (row) return fromRow(row);
  const inherited = tenantBudgets.find((b) => b.period === kind.period);
  if (inherited) {
    return {
      spendLimit: inherited.spendLimit,
      timeLimitMs: inherited.timeLimitMs,
      softThresholdPcts: normaliseThresholds(inherited.softThresholdPcts),
      escalationAttemptCap: null,
    };
  }
  return {
    spendLimit: BUDGET_DEFAULTS.spendLimit[kind.period],
    timeLimitMs: BUDGET_DEFAULTS.timeLimitMs[kind.period],
    softThresholdPcts: [...BUDGET_DEFAULTS.softThresholdPcts],
    escalationAttemptCap: null,
  };
}

/** FR-013: the smallest cap any applicable limit sets; with none set, the fail-closed default. */
export function tightestEscalationCap(caps: readonly (number | null)[]): number {
  const set = caps.filter((c): c is number => c !== null);
  return set.length === 0 ? BUDGET_DEFAULTS.escalationAttemptCap : Math.min(...set);
}

/** R-12: the tenant's declared degradation order, from 012's `tenant_budget.degradation_order`
 *  (day row preferred). It may reorder or shorten the closed list but never extend it: an entry
 *  outside `DEGRADATION_ORDER` makes the whole declaration unusable, and the product's own
 *  declared order applies instead. */
export function resolveDegradationOrder(tenantBudgets: readonly TenantBudgetRow[]): string[] {
  const declared = (['day', 'month'] as const)
    .map((p) => tenantBudgets.find((b) => b.period === p)?.degradationOrder)
    .find((order) => order !== undefined && order.length > 0);
  const known: readonly string[] = DEGRADATION_ORDER;
  if (declared && declared.every((entry) => known.includes(entry))) return [...declared];
  return [...DEGRADATION_ORDER];
}

/** Conditions in 012's `tenant_budget` that were replaced by a fail-closed value — an unknown
 *  degradation entry (the declared order applies instead), a soft threshold outside 1..99 (it is
 *  ignored). The replacement is correct; *silently* replacing it would leave a tenant believing a
 *  configuration is in force that is not, so each one is reported to readers and logged. */
export function budgetConfigWarnings(tenantBudgets: readonly TenantBudgetRow[]): string[] {
  const known: readonly string[] = DEGRADATION_ORDER;
  const warnings: string[] = [];
  for (const b of tenantBudgets) {
    const unknown = b.degradationOrder.filter((entry) => !known.includes(entry));
    if (unknown.length > 0) {
      warnings.push(
        `tenant_budget(${b.period}).degradation_order names unknown entries [${unknown.join(', ')}]; the declared order applies`,
      );
    }
    const dropped = (b.softThresholdPcts ?? []).filter(
      (p) => !(Number.isInteger(p) && p >= 1 && p <= 99),
    );
    if (dropped.length > 0) {
      warnings.push(
        `tenant_budget(${b.period}).soft_threshold_pcts has out-of-range values [${dropped.join(', ')}]; they are ignored`,
      );
    }
  }
  return warnings;
}
