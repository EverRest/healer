import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import type { ScopeFigures } from '../../domain/budget-figures.js';
import type { ResolvedBudget } from '../../domain/budget-repository.js';
import { DEGRADATION_ORDER } from '../../domain/degradation.js';
import { FakeReadOnlyBudgetRepository } from '../../domain/test-support/fake-budget-repository.js';
import { getBudgetState } from './get-budget-state.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000c1');

const scopeOf = (o: Partial<ScopeFigures>): ScopeFigures => ({
  scopeType: 'tenant',
  scopeId: CONTEXT.tenantId,
  period: 'day',
  periodKey: '2026-10-02',
  spendConsumed: 0,
  spendLimit: 100,
  timeConsumedMs: 0,
  timeLimitMs: 1000,
  softThresholdPcts: [50, 75, 90],
  ...o,
});

const repoOf = (...scopes: ScopeFigures[]) => {
  const budget: ResolvedBudget = {
    scopes,
    escalation: { attemptCount: 0, cap: 2 },
    degradationOrder: DEGRADATION_ORDER,
  };
  return new FakeReadOnlyBudgetRepository(budget);
};
const asOf = new Date('2026-10-02T12:00:00Z');

// T067 (FR-011): GET /budgets/state — the same derived aggregate policy enforces, shaped for a
// reader. No counter is stored; support and policy read one number.
describe('getBudgetState', () => {
  it('within: no threshold crossed', async () => {
    const state = await getBudgetState(repoOf(scopeOf({ spendConsumed: 10 })), CONTEXT, {
      scopeType: 'tenant',
      asOf,
    });
    expect(state).toMatchObject({
      state: 'within',
      consumedSpend: 10,
      spendLimit: 100,
      periodKey: '2026-10-02',
      degradationStep: 0,
      degradationApplied: [],
    });
  });

  it('degraded: names the entries applied so far, in order', async () => {
    const state = await getBudgetState(repoOf(scopeOf({ spendConsumed: 80 })), CONTEXT, {
      scopeType: 'tenant',
      asOf,
    });
    expect(state).toMatchObject({
      state: 'degraded',
      degradationStep: 2,
      degradationApplied: ['cheaper_tier', 'reduced_context'],
    });
  });

  it('exhausted: the limit is reached', async () => {
    const state = await getBudgetState(repoOf(scopeOf({ spendConsumed: 100 })), CONTEXT, {
      scopeType: 'tenant',
      asOf,
    });
    expect(state?.state).toBe('exhausted');
  });

  it('time can exhaust a budget on its own', async () => {
    const state = await getBudgetState(repoOf(scopeOf({ timeConsumedMs: 1000 })), CONTEXT, {
      scopeType: 'tenant',
      asOf,
    });
    expect(state).toMatchObject({ state: 'exhausted', consumedTimeMs: 1000, timeLimitMs: 1000 });
  });

  it('selects the requested tenant period, day by default', async () => {
    const repo = repoOf(
      scopeOf({ spendLimit: 100 }),
      scopeOf({ period: 'month', periodKey: '2026-10', spendLimit: 999 }),
    );
    expect((await getBudgetState(repo, CONTEXT, { scopeType: 'tenant', asOf }))?.spendLimit).toBe(
      100,
    );
    expect(
      (await getBudgetState(repo, CONTEXT, { scopeType: 'tenant', period: 'month', asOf }))
        ?.spendLimit,
    ).toBe(999);
  });

  it('selects the issue scope when asked about an issue', async () => {
    const repo = repoOf(
      scopeOf({}),
      scopeOf({
        scopeType: 'issue',
        scopeId: 'issue-1',
        period: 'issue',
        periodKey: 'issue',
        spendLimit: 2,
        spendConsumed: 2,
      }),
    );
    const state = await getBudgetState(repo, CONTEXT, {
      scopeType: 'issue',
      scopeId: 'issue-1',
      asOf,
    });
    expect(state).toMatchObject({ state: 'exhausted', spendLimit: 2, periodKey: 'issue' });
  });
});
