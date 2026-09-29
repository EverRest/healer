// @healer/domain-policy — entry surface. Nothing is exported until it exists (012 FR-001).

export { ACTION_CLASSES, type ActionClass } from './domain/action-class.js';
export { ACTION_CEILING, type AutonomyLevel, type Ceiling } from './domain/ceiling.js';
export { decisionInputSchema, type DecisionInput } from './domain/decision-input.js';
export { evaluate, type BudgetState, type Decision, type EvaluationTrace, type MatchedRuleTrace } from './domain/evaluate.js';
export type { ImpactClosure } from './domain/impact-closure.js';
export { ISSUE_KINDS, ISSUE_STATES, type IssueKind, type IssueState } from './domain/issue-enums.js';
export { OUTCOME_ORDER, foldOutcomes, maxOutcome, type Outcome } from './domain/outcome-lattice.js';
export {
  SEED_POLICY_ACTIONS,
  type PolicyAction,
  type PolicyActionRepository,
} from './domain/policy-action-repository.js';
export * from './domain/predicates/index.js';
export { REASON_CODES, type ReasonCode } from './domain/reason-code.js';
export type { CooldownBounds, ResolvedRuleset, Rule } from './domain/rule.js';
export { PrismaPolicyActionRepository } from './infrastructure/prisma-policy-action-repository.js';
