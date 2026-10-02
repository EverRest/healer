import { HealerError } from '@healer/shared';

// T088 (FR-021): product bounds on the escalation attempt cap and on the per-issue and per-tenant
// budgets, and the fail-closed starting values for everything left unset (stage 0 S0-7).
//
// **The maxima are literals in the migration too**
// (`20261003090000_budget_limit_bounds`, as CHECK constraints) and `budget-bounds.test.ts` fails if
// the two disagree. They are stop rules, not tuning knobs: a tenant configuration cannot cross
// them, and neither can a direct write.
//
// Spend is in the currency unit `agent_run.cost` is recorded in; time is milliseconds (012's
// `tenant_budget.time_limit` leaves the unit unstated — QUESTIONS.md "002 Phase 6").

export type BudgetPeriod = 'issue' | 'day' | 'month';

export const BUDGET_BOUNDS = {
  maxEscalationAttemptCap: 5,
  maxSpendLimit: { issue: 50, day: 500, month: 5000 },
  maxTimeLimitMs: { issue: 14_400_000, day: 86_400_000, month: 1_728_000_000 },
} as const;

// Starting values chosen to fail closed — tight budgets, low caps — until stage 0 supplies grounds
// to loosen them. Used when a tenant has configured nothing (and has no 012 `tenant_budget` row to
// inherit): an unconfigured tenant is bounded, never unbounded.
export const BUDGET_DEFAULTS = {
  spendLimit: { issue: 2, day: 20, month: 200 },
  timeLimitMs: { issue: 3_600_000, day: 28_800_000, month: 288_000_000 },
  softThresholdPcts: [50, 75, 90],
  escalationAttemptCap: 2,
} as const;

export class BudgetBoundExceededError extends HealerError {
  constructor(
    readonly field: string,
    readonly bound: number,
  ) {
    super('VALIDATION', `${field} is outside the product bound (0..${bound}); FR-021`);
    this.name = 'BudgetBoundExceededError';
  }
}

export interface BudgetLimitWrite {
  readonly period: BudgetPeriod;
  readonly spendLimit?: number;
  readonly timeLimitMs?: number;
  readonly escalationAttemptCap?: number;
}

/** Refuses a configuration write that crosses a product bound (FR-021). The database CHECKs say
 *  the same thing; this is the typed refusal in front of them. */
export function assertWithinBudgetBounds(write: BudgetLimitWrite): void {
  const { period } = write;
  if (write.spendLimit !== undefined) {
    const bound = BUDGET_BOUNDS.maxSpendLimit[period];
    if (!(write.spendLimit >= 0 && write.spendLimit <= bound)) {
      throw new BudgetBoundExceededError('spendLimit', bound);
    }
  }
  if (write.timeLimitMs !== undefined) {
    const bound = BUDGET_BOUNDS.maxTimeLimitMs[period];
    if (!(write.timeLimitMs >= 0 && write.timeLimitMs <= bound)) {
      throw new BudgetBoundExceededError('timeLimitMs', bound);
    }
  }
  if (write.escalationAttemptCap !== undefined) {
    const bound = BUDGET_BOUNDS.maxEscalationAttemptCap;
    if (!(write.escalationAttemptCap >= 0 && write.escalationAttemptCap <= bound)) {
      throw new BudgetBoundExceededError('escalationAttemptCap', bound);
    }
  }
}
