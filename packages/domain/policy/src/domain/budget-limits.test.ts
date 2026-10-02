import { describe, expect, it } from 'vitest';
import { BUDGET_DEFAULTS } from './budget-bounds.js';
import {
  budgetConfigWarnings,
  effectiveLimit,
  normaliseThresholds,
  resolveDegradationOrder,
  tightestEscalationCap,
  type LimitRow,
  type TenantBudgetRow,
} from './budget-limits.js';
import { DEGRADATION_ORDER } from './degradation.js';

// T057 (FR-011, R-10): per-issue limits, and per-tenant-period limits **inherited** from 012's
// `tenant_budget` rather than converted. Precedence, most specific first: an issue-specific row,
// the per-issue default row, the product's fail-closed default; for a tenant period, a
// `budget_limit` row, then 012's `tenant_budget` row, then the default. Nothing is ever unbounded.

const row = (overrides: Partial<LimitRow>): LimitRow => ({
  scopeType: 'tenant',
  scopeId: null,
  period: 'day',
  spendLimit: 10,
  timeLimitMs: 1000,
  softThresholdPcts: [40],
  escalationAttemptCap: 1,
  ...overrides,
});

const inherited: TenantBudgetRow = {
  period: 'day',
  spendLimit: 30,
  timeLimitMs: 5000,
  softThresholdPcts: [60, 80],
  degradationOrder: ['diagnosis_only'],
};

describe('effectiveLimit — tenant periods', () => {
  it('a budget_limit row wins over 012 tenant_budget', () => {
    const result = effectiveLimit({ scopeType: 'tenant', period: 'day' }, [row({})], [inherited]);
    expect(result).toMatchObject({ spendLimit: 10, timeLimitMs: 1000, escalationAttemptCap: 1 });
    expect(result.softThresholdPcts).toEqual([40]);
  });

  it('with no budget_limit row, 012 tenant_budget is inherited as it stands (soft thresholds too)', () => {
    const result = effectiveLimit({ scopeType: 'tenant', period: 'day' }, [], [inherited]);
    expect(result).toMatchObject({ spendLimit: 30, timeLimitMs: 5000, escalationAttemptCap: null });
    expect(result.softThresholdPcts).toEqual([60, 80]);
  });

  it('with neither, the fail-closed product default applies — never unbounded', () => {
    const result = effectiveLimit({ scopeType: 'tenant', period: 'month' }, [], [inherited]);
    expect(result).toMatchObject({
      spendLimit: BUDGET_DEFAULTS.spendLimit.month,
      timeLimitMs: BUDGET_DEFAULTS.timeLimitMs.month,
      escalationAttemptCap: null,
    });
    expect(result.softThresholdPcts).toEqual([...BUDGET_DEFAULTS.softThresholdPcts]);
  });

  it('day and month rows do not bleed into each other', () => {
    const rows = [row({ period: 'month', spendLimit: 99 })];
    expect(effectiveLimit({ scopeType: 'tenant', period: 'day' }, rows, []).spendLimit).toBe(
      BUDGET_DEFAULTS.spendLimit.day,
    );
  });
});

describe('effectiveLimit — per-issue', () => {
  const issueDefault = row({ scopeType: 'issue', period: 'issue', spendLimit: 3 });
  const issueOverride = row({
    scopeType: 'issue',
    period: 'issue',
    scopeId: 'issue-1',
    spendLimit: 7,
  });

  it('an issue-specific row wins over the per-issue default row', () => {
    expect(
      effectiveLimit({ scopeType: 'issue' }, [issueDefault, issueOverride], [], 'issue-1')
        .spendLimit,
    ).toBe(7);
  });

  it('another issue sees only the per-issue default row', () => {
    expect(
      effectiveLimit({ scopeType: 'issue' }, [issueDefault, issueOverride], [], 'issue-2')
        .spendLimit,
    ).toBe(3);
  });

  it('with no row, the fail-closed per-issue default applies', () => {
    expect(effectiveLimit({ scopeType: 'issue' }, [], [], 'issue-1').spendLimit).toBe(
      BUDGET_DEFAULTS.spendLimit.issue,
    );
  });
});

describe('normaliseThresholds', () => {
  it('sorts, dedupes and keeps integers in 1..99', () => {
    expect(normaliseThresholds([90, 50, 50, 75])).toEqual([50, 75, 90]);
    expect(normaliseThresholds([0, 100, 150, -5, 50.5, 60])).toEqual([60]);
  });
  it('null means unset → the product default; an explicit empty list means no soft steps', () => {
    expect(normaliseThresholds(null)).toEqual([...BUDGET_DEFAULTS.softThresholdPcts]);
    expect(normaliseThresholds([])).toEqual([]);
  });
});

describe('tightestEscalationCap (FR-013)', () => {
  it('is the smallest cap any applicable limit sets', () => {
    expect(tightestEscalationCap([1, 3, null])).toBe(1);
  });
  it('falls back to the fail-closed default when no limit sets one', () => {
    expect(tightestEscalationCap([null, null])).toBe(BUDGET_DEFAULTS.escalationAttemptCap);
  });
});

describe('budgetConfigWarnings — a replaced configuration is surfaced, never silent', () => {
  const tb = (over: Partial<TenantBudgetRow>): TenantBudgetRow => ({ ...inherited, ...over });

  it('says nothing about a valid configuration', () => {
    expect(budgetConfigWarnings([inherited])).toEqual([]);
  });

  it('names an unknown degradation entry and says the declared order applies', () => {
    const w = budgetConfigWarnings([
      tb({ degradationOrder: ['cheaper_tier', 'delete_everything'] }),
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/tenant_budget\(day\)/);
    expect(w[0]).toMatch(/delete_everything/);
  });

  it('names out-of-range soft thresholds that were ignored', () => {
    const w = budgetConfigWarnings([tb({ period: 'month', softThresholdPcts: [50, 0, 150] })]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/tenant_budget\(month\)/);
    expect(w[0]).toMatch(/0, 150/);
  });

  it('treats null thresholds (unset) as fine', () => {
    expect(budgetConfigWarnings([tb({ softThresholdPcts: null })])).toEqual([]);
  });
});

describe('resolveDegradationOrder (R-12)', () => {
  const tb = (period: 'day' | 'month', degradationOrder: string[]): TenantBudgetRow => ({
    ...inherited,
    period,
    degradationOrder,
  });

  it("uses the tenant's declared order when every entry is a member of the closed list", () => {
    expect(resolveDegradationOrder([tb('day', ['diagnosis_only', 'cheaper_tier'])])).toEqual([
      'diagnosis_only',
      'cheaper_tier',
    ]);
  });

  it('a tenant cannot invent an entry the product has no handling for: unknown → the declared default', () => {
    expect(resolveDegradationOrder([tb('day', ['cheaper_tier', 'delete_everything'])])).toEqual([
      ...DEGRADATION_ORDER,
    ]);
  });

  it('no tenant_budget row, or an empty order, → the declared default', () => {
    expect(resolveDegradationOrder([])).toEqual([...DEGRADATION_ORDER]);
    expect(resolveDegradationOrder([tb('day', [])])).toEqual([...DEGRADATION_ORDER]);
  });

  it('prefers the day row over the month row', () => {
    expect(
      resolveDegradationOrder([tb('month', ['cheaper_tier']), tb('day', ['diagnosis_only'])]),
    ).toEqual(['diagnosis_only']);
  });
});
