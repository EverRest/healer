import type { DecisionInput } from './decision-input.js';
import type { PredicateConjunction } from './predicates/types.js';
import type { Outcome } from './outcome-lattice.js';
import type { ReasonCode } from './reason-code.js';

// A published `policy_rule` (data-model.md), as `evaluate()` consumes it — immutable, belongs to
// a resolved rule set. No priority field: evaluation matches every rule and folds (R-04).
export interface Rule {
  readonly ruleKey: string;
  readonly predicates: PredicateConjunction;
  readonly outcome: Outcome;
  readonly reasonCode: ReasonCode;
}

/** The rate/cooldown/attempt-cap bounds of `policy.action_limit` (FR-014, T054). They travel inside
 *  `DecisionInput.cooldown.bounds` — resolved with the counts, stored with the decision. */
export type CooldownBounds = NonNullable<DecisionInput['cooldown']['bounds']>;

// The published rule set version, already resolved for the tenant and the action being proposed
// — `evaluate()` does not fetch it (contracts/evaluation.md step 1).
export interface ResolvedRuleset {
  readonly version: number;
  readonly rules: readonly Rule[];
  /** `budget_limit.escalation_attempt_cap` (FR-013, T066), compared against the
   *  `escalation.attemptCount` input. */
  readonly escalationAttemptCap?: number;
}
