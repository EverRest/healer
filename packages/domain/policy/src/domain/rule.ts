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

// The rate/cooldown/attempt-cap bounds of `policy.action_limit` (data-model.md), resolved
// alongside the rule set for the action being evaluated (R-13: "read in the same query as the
// rule set"). `action_limit`'s repository does not exist yet in this repository (Phase 5,
// T054) — this shape is this batch's own invention of what `evaluate()` needs from it, kept to
// exactly the three bounds the cooldown step compares against; a real caller assembles this
// alongside `ResolvedRuleset.rules` once T054 lands. Absent when the tenant has not configured a
// bound for this action key, in which case step 6 has nothing to enforce.
export interface CooldownBounds {
  readonly ratePerWindow: number;
  readonly cooldownSeconds: number;
  readonly attemptCap: number;
}

// The published rule set version, already resolved for the tenant and the action being proposed
// — `evaluate()` does not fetch it (contracts/evaluation.md step 1).
export interface ResolvedRuleset {
  readonly version: number;
  readonly rules: readonly Rule[];
  readonly cooldownBounds?: CooldownBounds;
}
