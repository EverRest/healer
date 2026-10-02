import { describe, expect, it } from 'vitest';
import { bindingBudget, type ScopeFigures } from './budget-figures.js';

const scope = (overrides: Partial<ScopeFigures> = {}): ScopeFigures => ({
  scopeType: 'tenant',
  scopeId: 'tenant-1',
  period: 'day',
  periodKey: '2026-10-02',
  spendConsumed: 0,
  spendLimit: 100,
  timeConsumedMs: 0,
  timeLimitMs: 1000,
  softThresholdPcts: [50, 75, 90],
  ...overrides,
});

// FR-011: a step must fit every budget that applies to it (per-issue AND per-tenant, spend AND
// time). The evaluator takes one (consumed, limit) pair, so the pair handed to it is the most
// constrained one — the budget this step is closest to breaking.
describe('bindingBudget', () => {
  it('picks the scope with the least headroom once the declared maximum is charged', () => {
    const issue = scope({
      scopeType: 'issue',
      scopeId: 'i1',
      period: 'issue',
      periodKey: 'issue',
      spendConsumed: 1,
      spendLimit: 2,
    });
    const day = scope({ spendConsumed: 10, spendLimit: 100 });
    const result = bindingBudget([day, issue], 0.5);
    expect(result.scope.scopeType).toBe('issue');
    expect(result.budget).toMatchObject({ consumed: 1, limit: 2, declaredMaxCost: 0.5 });
  });

  it('a declared maximum can move the binding scope: charging it is what makes the issue tighter', () => {
    const issue = scope({
      scopeType: 'issue',
      scopeId: 'i1',
      period: 'issue',
      periodKey: 'issue',
      spendConsumed: 1,
      spendLimit: 10,
    });
    const day = scope({ spendConsumed: 60, spendLimit: 100 });
    expect(bindingBudget([issue, day], 0).scope.scopeType).toBe('tenant');
    expect(bindingBudget([issue, day], 9).scope.scopeType).toBe('issue');
  });

  it('time can bind instead of spend, and then no spend is declared against it', () => {
    const s = scope({ spendConsumed: 1, spendLimit: 100, timeConsumedMs: 900, timeLimitMs: 1000 });
    const result = bindingBudget([s], 2);
    expect(result.dimension).toBe('time');
    expect(result.budget).toMatchObject({ consumed: 900, limit: 1000, declaredMaxCost: 0 });
  });

  it('reports the degradation step of the binding dimension, from consumed / limit alone', () => {
    const s = scope({ spendConsumed: 80, spendLimit: 100 });
    expect(bindingBudget([s], 0).budget.degradationStep).toBe(2);
    // declared maximum is a forecast, not consumption: it never advances the step
    expect(bindingBudget([s], 15).budget.degradationStep).toBe(2);
  });

  it('is deterministic when two scopes tie: the per-issue scope wins, then day, then month', () => {
    const issue = scope({ scopeType: 'issue', scopeId: 'i1', period: 'issue', periodKey: 'issue' });
    const day = scope();
    const month = scope({ period: 'month', periodKey: '2026-10' });
    expect(bindingBudget([month, day, issue], 0).scope.period).toBe('issue');
    expect(bindingBudget([month, day], 0).scope.period).toBe('day');
  });

  it('a zero limit is the most constrained scope there is', () => {
    const s = scope({ spendLimit: 0 });
    const issue = scope({
      scopeType: 'issue',
      period: 'issue',
      periodKey: 'issue',
      spendConsumed: 99,
      spendLimit: 100,
    });
    expect(bindingBudget([issue, s], 1).scope.scopeType).toBe('tenant');
  });

  it('refuses an empty scope list — the resolver always supplies fail-closed defaults', () => {
    expect(() => bindingBudget([], 1)).toThrow();
  });
});
