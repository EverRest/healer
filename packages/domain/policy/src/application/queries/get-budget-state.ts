import { scope, type TenantContext } from '@healer/shared';
import { scopeStanding } from '../../domain/budget-figures.js';
import type { ReadOnlyBudgetRepository } from '../../domain/budget-repository.js';
import { entryForStep, stepsToMark } from '../../domain/degradation.js';

export interface BudgetStateQuery {
  readonly scopeType: 'issue' | 'tenant';
  /** The issue id for `scopeType: 'issue'`; ignored for `tenant` (the tenant is the
   *  authenticated one, never a parameter). */
  readonly scopeId?: string;
  /** Tenant period; `day` when omitted. */
  readonly period?: 'day' | 'month';
  readonly workflowRunId?: string;
  readonly asOf: Date;
}

export interface BudgetState {
  readonly consumedSpend: number;
  readonly spendLimit: number;
  readonly consumedTimeMs: number;
  readonly timeLimitMs: number;
  readonly periodKey: string;
  readonly degradationStep: number;
  readonly degradationApplied: readonly string[];
  readonly state: 'within' | 'degraded' | 'exhausted';
  /** Configuration replaced by a fail-closed value (an unknown degradation entry, an out-of-range
   *  threshold in 012's tenant_budget) — what is enforced is not what was written, and a reader
   *  is told so. */
  readonly warnings: readonly string[];
}

/** `GET /budgets/state` (T067, FR-011): the derived aggregate shaped for a reader. Nothing here is
 *  stored — it is the same figures policy enforces (R-10). Returns null when the requested scope
 *  is not among those resolved (an issue was asked for but none was named). */
export async function getBudgetState(
  repo: ReadOnlyBudgetRepository,
  context: TenantContext,
  query: BudgetStateQuery,
): Promise<BudgetState | null> {
  const budget = await repo.resolve(
    scope(context, {
      ...(query.scopeType === 'issue' && query.scopeId !== undefined
        ? { issueId: query.scopeId }
        : {}),
      ...(query.workflowRunId !== undefined ? { workflowRunId: query.workflowRunId } : {}),
      asOf: query.asOf,
    }),
  );
  const figures = budget.scopes.find((s) =>
    query.scopeType === 'issue'
      ? s.scopeType === 'issue'
      : s.scopeType === 'tenant' && s.period === (query.period ?? 'day'),
  );
  if (figures === undefined) return null;

  const standing = scopeStanding(figures);
  const count = figures.softThresholdPcts.length;
  const applied = stepsToMark({
    crossed: standing.crossed,
    exhausted: standing.exhausted,
    thresholdCount: count,
  }).map((step) => entryForStep(budget.degradationOrder, step, count));
  return {
    consumedSpend: figures.spendConsumed,
    spendLimit: figures.spendLimit,
    consumedTimeMs: figures.timeConsumedMs,
    timeLimitMs: figures.timeLimitMs,
    periodKey: figures.periodKey,
    degradationStep: standing.crossed,
    degradationApplied: applied,
    state: standing.exhausted ? 'exhausted' : standing.crossed > 0 ? 'degraded' : 'within',
    warnings: budget.warnings,
  };
}
