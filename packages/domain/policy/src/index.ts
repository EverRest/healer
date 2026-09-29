// @healer/domain-policy — entry surface. Nothing is exported until it exists (012 FR-001).

export { ACTION_CLASSES, type ActionClass } from './domain/action-class.js';
export type { AuditActorType, NewAuditEntry } from './domain/audit-entry.js';
export { ACTION_CEILING, type AutonomyLevel, type Ceiling } from './domain/ceiling.js';
export { computeConflictWarnings, couldBothMatch, type ConflictWarning } from './domain/conflict-warnings.js';
export { decisionInputSchema, type DecisionInput } from './domain/decision-input.js';
export { evaluate, type BudgetState, type Decision, type EvaluationTrace, type MatchedRuleTrace } from './domain/evaluate.js';
export * from './domain/events.js';
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
export { computeRulesetDigest, type RuleBody } from './domain/policy-ruleset.js';
export type {
  NewPublishedRuleset,
  PolicyRulesetRepository,
  PublishedRuleset,
} from './domain/policy-ruleset-repository.js';
export { computeProposalDigest } from './domain/proposal-digest.js';
export {
  DecisionAlreadyConsumedError,
  DigestMismatchError,
  type ConsumeDecisionInput,
  type DecisionBinding,
  type NewRecordedDecision,
  type PolicyDecisionRepository,
  type RecordedDecision,
} from './domain/policy-decision-repository.js';
export { publishRuleset } from './application/commands/publish-ruleset.js';
export { evaluateAndBind } from './application/commands/evaluate-and-bind.js';
export { consumeDecision } from './application/commands/consume-decision.js';
export { PrismaPolicyActionRepository } from './infrastructure/prisma-policy-action-repository.js';
export { PrismaPolicyRulesetRepository } from './infrastructure/prisma-policy-ruleset-repository.js';
export { PrismaPolicyDecisionRepository } from './infrastructure/prisma-policy-decision-repository.js';
export { PrismaAutonomyEpochRepository } from './infrastructure/prisma-autonomy-epoch-repository.js';
export { recordAuditEntry } from './infrastructure/record-audit-entry.js';
