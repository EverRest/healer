import type { BudgetPeriod } from './budget-bounds.js';
import type { DecisionInput } from './decision-input.js';
import { degradationStepOf } from './degradation.js';

/** One budget scope's figures for one period (`budget_limit` joined to its derived consumption).
 *  Nothing here is stored: consumption is aggregated from `agent_run` and `workflow_run` (R-10). */
export interface ScopeFigures {
  readonly scopeType: 'issue' | 'tenant';
  readonly scopeId: string;
  readonly period: BudgetPeriod;
  readonly periodKey: string;
  readonly spendConsumed: number;
  readonly spendLimit: number;
  readonly timeConsumedMs: number;
  readonly timeLimitMs: number;
  /** Sorted, distinct, within 1..99 — normalised by the resolver. */
  readonly softThresholdPcts: readonly number[];
}

export interface BindingBudget {
  readonly scope: ScopeFigures;
  readonly dimension: 'spend' | 'time';
  /** Exactly what the evaluator's `budget` input group carries. */
  readonly budget: DecisionInput['budget'];
}

const SCOPE_RANK: Record<string, number> = { 'issue:issue': 0, 'tenant:day': 1, 'tenant:month': 2 };
const rankOf = (s: ScopeFigures): number => SCOPE_RANK[`${s.scopeType}:${s.period}`] ?? 9;

const ratio = (used: number, limit: number): number => (limit <= 0 ? Infinity : used / limit);

interface Candidate {
  readonly scope: ScopeFigures;
  readonly dimension: 'spend' | 'time';
  readonly used: number;
}

/**
 * FR-011: a step has to fit **every** budget that applies to it — per-issue and per-tenant, spend
 * and time — but the evaluator takes one `(consumed, limit)` pair. The pair handed to it is the
 * most constrained one: the budget this step, once its declared maximum is charged, is closest to
 * breaking. Ties resolve by a fixed order (per-issue, day, month; spend before time), so the same
 * figures always bind the same scope.
 *
 * Time carries no declared maximum — nothing declares an execution-time forecast — so when time
 * binds, `declaredMaxCost` is 0 and the predicate degrades to "already exhausted".
 */
export function bindingBudget(
  scopes: readonly ScopeFigures[],
  declaredMaxCost: number,
): BindingBudget {
  const candidates: Candidate[] = scopes.flatMap((scope) => [
    {
      scope,
      dimension: 'spend' as const,
      used: ratio(scope.spendConsumed + declaredMaxCost, scope.spendLimit),
    },
    { scope, dimension: 'time' as const, used: ratio(scope.timeConsumedMs, scope.timeLimitMs) },
  ]);
  const [first, ...rest] = candidates;
  if (first === undefined)
    throw new Error('no budget scope applies — the resolver must supply defaults');
  const winner = rest.reduce((best, c) => {
    if (c.used !== best.used) return c.used > best.used ? c : best;
    if (rankOf(c.scope) !== rankOf(best.scope))
      return rankOf(c.scope) < rankOf(best.scope) ? c : best;
    return best;
  }, first);

  const { scope, dimension } = winner;
  const consumed = dimension === 'spend' ? scope.spendConsumed : scope.timeConsumedMs;
  const limit = dimension === 'spend' ? scope.spendLimit : scope.timeLimitMs;
  return {
    scope,
    dimension,
    budget: {
      consumed,
      limit,
      declaredMaxCost: dimension === 'spend' ? declaredMaxCost : 0,
      degradationStep: degradationStepOf(consumed, limit, scope.softThresholdPcts),
    },
  };
}

/** Where one scope stands on its own — the crossed-threshold count over both dimensions and
 *  whether either is at its limit. What `MarkDegradation` records, per scope and period. */
export function scopeStanding(scope: ScopeFigures): {
  readonly crossed: number;
  readonly exhausted: boolean;
  /** The dimension closer to its limit, with its own figures — what the evidence record names. */
  readonly dimension: 'spend' | 'time';
  readonly consumed: number;
  readonly limit: number;
} {
  const spend = ratio(scope.spendConsumed, scope.spendLimit);
  const time = ratio(scope.timeConsumedMs, scope.timeLimitMs);
  const dimension = time > spend ? 'time' : 'spend';
  return {
    crossed: Math.max(
      degradationStepOf(scope.spendConsumed, scope.spendLimit, scope.softThresholdPcts),
      degradationStepOf(scope.timeConsumedMs, scope.timeLimitMs, scope.softThresholdPcts),
    ),
    exhausted: scope.spendConsumed >= scope.spendLimit || scope.timeConsumedMs >= scope.timeLimitMs,
    dimension,
    consumed: dimension === 'spend' ? scope.spendConsumed : scope.timeConsumedMs,
    limit: dimension === 'spend' ? scope.spendLimit : scope.timeLimitMs,
  };
}
