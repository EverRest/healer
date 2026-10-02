import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertWithinBudgetBounds,
  BUDGET_BOUNDS,
  BUDGET_DEFAULTS,
  BudgetBoundExceededError,
} from './budget-bounds.js';

// T088 (FR-021): a literal maximum in the migration, the same value as a constant in code, and a
// test that the two agree — the same shape `gate-ceiling` gives the autonomy ceiling. The bounds
// are stop rules, not tuning knobs.
const MIGRATION_SQL = fileURLToPath(
  new URL(
    '../../../../../prisma/migrations/20261003090000_budget_limit_bounds/migration.sql',
    import.meta.url,
  ),
);
const sql = readFileSync(MIGRATION_SQL, 'utf8');

/** `CASE period WHEN 'issue' THEN a WHEN 'day' THEN b ELSE c END` tagged by a constraint name. */
function caseLiterals(constraint: string): { issue: number; day: number; month: number } {
  const body = sql.match(
    new RegExp(`${constraint}[\\s\\S]*?CHECK([\\s\\S]*?)(?:,\\s*\\n\\s*ADD|;)`),
  );
  if (!body?.[1]) throw new Error(`migration has no ${constraint}`);
  const m = body[1].match(/WHEN 'issue' THEN (\d+) WHEN 'day' THEN (\d+) ELSE (\d+) END/);
  if (!m) throw new Error(`${constraint} has no CASE literals`);
  return { issue: Number(m[1]), day: Number(m[2]), month: Number(m[3]) };
}

describe('budget product bounds (T088, FR-021)', () => {
  it('the escalation attempt cap maximum in the migration equals the constant in code', () => {
    const m = sql.match(/"escalation_attempt_cap"\s+BETWEEN\s+0\s+AND\s+(\d+)/);
    expect(m, 'migration must bound escalation_attempt_cap with a literal').not.toBeNull();
    expect(Number(m?.[1])).toBe(BUDGET_BOUNDS.maxEscalationAttemptCap);
  });

  it('the per-issue and per-tenant spend maxima in the migration equal the constants in code', () => {
    expect(caseLiterals('budget_limit_spend_limit_bound')).toEqual(BUDGET_BOUNDS.maxSpendLimit);
  });

  it('the time maxima in the migration equal the constants in code', () => {
    expect(caseLiterals('budget_limit_time_limit_bound')).toEqual(BUDGET_BOUNDS.maxTimeLimitMs);
  });

  it('every fail-closed default sits inside its own bound', () => {
    expect(() =>
      assertWithinBudgetBounds({
        period: 'issue',
        spendLimit: BUDGET_DEFAULTS.spendLimit.issue,
        timeLimitMs: BUDGET_DEFAULTS.timeLimitMs.issue,
        escalationAttemptCap: BUDGET_DEFAULTS.escalationAttemptCap,
      }),
    ).not.toThrow();
    for (const period of ['day', 'month'] as const) {
      expect(() =>
        assertWithinBudgetBounds({
          period,
          spendLimit: BUDGET_DEFAULTS.spendLimit[period],
          timeLimitMs: BUDGET_DEFAULTS.timeLimitMs[period],
          escalationAttemptCap: BUDGET_DEFAULTS.escalationAttemptCap,
        }),
      ).not.toThrow();
    }
  });

  it('refuses a cap above the bound', () => {
    expect(() =>
      assertWithinBudgetBounds({
        period: 'issue',
        escalationAttemptCap: BUDGET_BOUNDS.maxEscalationAttemptCap + 1,
      }),
    ).toThrow(BudgetBoundExceededError);
  });

  it.each(['issue', 'day', 'month'] as const)(
    'refuses a %s spend limit above the bound',
    (period) => {
      expect(() =>
        assertWithinBudgetBounds({
          period,
          spendLimit: BUDGET_BOUNDS.maxSpendLimit[period] + 0.01,
        }),
      ).toThrow(BudgetBoundExceededError);
      expect(() =>
        assertWithinBudgetBounds({ period, spendLimit: BUDGET_BOUNDS.maxSpendLimit[period] }),
      ).not.toThrow();
    },
  );

  it.each(['issue', 'day', 'month'] as const)(
    'refuses a %s time limit above the bound',
    (period) => {
      expect(() =>
        assertWithinBudgetBounds({ period, timeLimitMs: BUDGET_BOUNDS.maxTimeLimitMs[period] + 1 }),
      ).toThrow(BudgetBoundExceededError);
    },
  );

  it('refuses negative limits', () => {
    expect(() => assertWithinBudgetBounds({ period: 'day', spendLimit: -1 })).toThrow(
      BudgetBoundExceededError,
    );
  });
});
