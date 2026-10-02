// @healer/domain-policy — entry surface. Nothing is exported until it exists (012 FR-001).

export { ACTION_CLASSES, type ActionClass } from './domain/action-class.js';
export {
  ApprovalAlreadyPendingError,
  ApprovalNotPendingError,
  type ApprovalLifecycleRepository,
  type DueApproval,
  type ApprovalListFilter,
  type ApprovalRequest,
  type ApprovalRequestRepository,
  type ApprovalRequestSummary,
} from './domain/approval-request-repository.js';
export {
  ApprovalNotDueError,
  ApprovalWithoutDeadlineError,
  assertDue,
  assertRedeemable,
  assertRequestable,
  buildLapseDecision,
  projectExpiry,
} from './domain/approval-lifecycle.js';
export {
  approvalSummarySchema,
  ApprovalSummaryNotStructuralError,
  buildApprovalSummary,
  type ApprovalSummary,
} from './domain/approval-summary.js';
export type { AuditActorType, NewAuditEntry } from './domain/audit-entry.js';
export {
  CeilingExceededError,
  GrantAlreadyRevokedError,
  type AutonomyGrant,
  type AutonomyGrantRepository,
  type NewAutonomyGrant,
  type ReadOnlyAutonomyGrantRepository,
  type RevokeAutonomyGrant,
} from './domain/autonomy-grant-repository.js';
export type { AutonomyEpochRepository } from './domain/autonomy-epoch-repository.js';
export { ACTION_CEILING, type AutonomyLevel, type Ceiling } from './domain/ceiling.js';
export { checkAutonomyEpoch, StaleAutonomyEpochError } from './domain/check-autonomy-epoch.js';
export {
  computeConflictWarnings,
  couldBothMatch,
  type ConflictWarning,
} from './domain/conflict-warnings.js';
export { decisionInputSchema, type DecisionInput } from './domain/decision-input.js';
export {
  evaluate,
  type BudgetState,
  type Decision,
  type EvaluationTrace,
  type MatchedRuleTrace,
} from './domain/evaluate.js';
export * from './domain/events.js';
export type { ImpactClosure } from './domain/impact-closure.js';
export {
  ISSUE_KINDS,
  ISSUE_STATES,
  type IssueKind,
  type IssueState,
} from './domain/issue-enums.js';
export { OUTCOME_ORDER, foldOutcomes, maxOutcome, type Outcome } from './domain/outcome-lattice.js';
export {
  SEED_POLICY_ACTIONS,
  type PolicyAction,
  type PolicyActionRepository,
} from './domain/policy-action-repository.js';
export * from './domain/predicates/index.js';
export { REASON_CODES, type ReasonCode } from './domain/reason-code.js';
export { resolveAutonomyLevel, type AutonomyGrantTarget } from './domain/resolve-autonomy-level.js';
export type { CooldownBounds, ResolvedRuleset, Rule } from './domain/rule.js';
export {
  assertValidPredicates,
  computeRulesetDigest,
  DuplicateRuleKeyError,
  RulesetPredicateInvalidError,
  type RuleBody,
} from './domain/policy-ruleset.js';
export {
  StaleRulesetVersionError,
  type NewPublishedRuleset,
  type PolicyRulesetRepository,
  type PublishedRuleset,
  type ReadOnlyPolicyRulesetRepository,
} from './domain/policy-ruleset-repository.js';
export { computeProposalDigest } from './domain/proposal-digest.js';
export {
  DecisionAlreadyConsumedError,
  DecisionNotAllowedError,
  DigestMismatchError,
  type ConsumeDecisionInput,
  type DecisionBinding,
  type DecisionListFilter,
  type NewRecordedDecision,
  type PolicyDecisionRepository,
  type RecordedDecision,
  type StoredDecision,
} from './domain/policy-decision-repository.js';
export { publishRuleset } from './application/commands/publish-ruleset.js';
export { evaluateAndBind } from './application/commands/evaluate-and-bind.js';
export {
  grantAutonomy,
  GRANT_AUTONOMY_AUDIT_ACTION,
  type GrantAutonomyInput,
} from './application/commands/grant-autonomy.js';
export {
  revokeAutonomy,
  REVOKE_AUTONOMY_AUDIT_ACTION,
  type RevokeAutonomyInput,
} from './application/commands/revoke-autonomy.js';
export {
  sweepRevokedApprovals,
  REVOKE_APPROVAL_AUDIT_ACTION,
  type SweepRevokedApprovalsResult,
} from './application/commands/sweep-revoked-approvals.js';
export {
  NoPublishedRulesetError,
  UnregisteredActionError,
} from './application/resolve-ruleset-and-evaluate.js';
export {
  expireApproval,
  expireDueApprovals,
  EXPIRE_APPROVAL_AUDIT_ACTION,
  type ExpireDueApprovalsResult,
} from './application/commands/expire-approval.js';
export {
  requestApproval,
  REQUEST_APPROVAL_AUDIT_ACTION,
  type RequestApprovalInput,
} from './application/commands/request-approval.js';
export {
  resolveApproval,
  RESOLVE_APPROVAL_AUDIT_ACTION,
  type ResolveApprovalInput,
} from './application/commands/resolve-approval.js';
export { consumeDecision } from './application/commands/consume-decision.js';
export {
  explainDecision,
  type ExplainDecisionRepos,
} from './application/queries/explain-decision.js';
export {
  replayDecision,
  RulesetVersionNotFoundError,
  type ReplayDecisionRepos,
} from './application/queries/replay-decision.js';
export { PrismaPolicyActionRepository } from './infrastructure/prisma-policy-action-repository.js';
export { PrismaPolicyRulesetRepository } from './infrastructure/prisma-policy-ruleset-repository.js';
export { PrismaPolicyDecisionRepository } from './infrastructure/prisma-policy-decision-repository.js';
export { PrismaAutonomyEpochRepository } from './infrastructure/prisma-autonomy-epoch-repository.js';
export { PrismaAutonomyGrantRepository } from './infrastructure/prisma-autonomy-grant-repository.js';
export { PrismaApprovalRequestRepository } from './infrastructure/prisma-approval-request-repository.js';
export { PrismaApprovalLifecycleRepository } from './infrastructure/prisma-approval-lifecycle-repository.js';
export { ApprovalRunTerminalError } from './infrastructure/approval-run-effects.js';
export { recordAuditEntry } from './infrastructure/record-audit-entry.js';
