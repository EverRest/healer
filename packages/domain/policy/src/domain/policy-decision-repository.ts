import { HealerError, type TenantScoped } from '@healer/shared';
import type { DecisionInput } from './decision-input.js';
import type { BudgetState, Decision } from './evaluate.js';

/** What binds a decision to the workflow it guards (data-model.md `policy_decision`,
 *  contracts/evaluation.md "Binding, consumption and validity") — everything here is optional
 *  because `EvaluateAndBind` is called by features that propose against an issue and a workflow
 *  run, but nothing in this batch requires either to exist yet. `targetRef`/`fingerprint` are
 *  *not* here: they are `decisionInput.target.targetRef`/`.fingerprint` (contracts/
 *  evaluation.md), so `EvaluateAndBind` derives them from the same input `evaluate()` reads
 *  rather than asking the caller to repeat them and risk the two disagreeing. */
export interface DecisionBinding {
  readonly issueId?: string;
  readonly workflowRunId?: string;
  readonly workflowState?: string;
}

/** A persisted decision, as `PolicyDecisionRepository.record` returns it. */
export interface RecordedDecision extends Decision {
  readonly id: string;
  readonly proposalDigest: string;
}

/** What `record()` writes — the pure `Decision`/`EvaluationTrace` batch 3 already computed, plus
 *  everything about *this* proposal that is not itself part of the pure fold. */
export interface NewRecordedDecision {
  readonly id: string;
  readonly decision: Decision;
  readonly decisionInput: DecisionInput;
  readonly proposalDigest: string;
  readonly budgetState: BudgetState;
  readonly actionKey: string;
  readonly targetRef?: string;
  readonly fingerprint?: string;
  readonly binding: DecisionBinding;
}

export interface ConsumeDecisionInput {
  readonly decisionId: string;
  readonly presentedDigest: string;
}

/** `error.code` mirrors `@healer/shared`'s closed `ErrorCode` union (T023, contracts/
 *  evaluation.md "Error codes") — `DECISION_ALREADY_CONSUMED` maps to HTTP 409 via
 *  `httpStatusFor`, the same as every other typed error in this repository. */
export class DecisionAlreadyConsumedError extends HealerError {
  constructor(readonly decisionId: string) {
    super('DECISION_ALREADY_CONSUMED', `policy decision ${decisionId} has already been consumed`);
    this.name = 'DecisionAlreadyConsumedError';
  }
}

export class DigestMismatchError extends HealerError {
  constructor(readonly decisionId: string) {
    super('DIGEST_MISMATCH', `presented digest does not match decision ${decisionId}'s proposal digest`);
    this.name = 'DigestMismatchError';
  }
}

/**
 * `policy_decision` (T021/T023, data-model.md). Every method takes `TenantScoped` (T015).
 */
export interface PolicyDecisionRepository {
  /** Persists the decision and publishes `PolicyDecisionRecorded` through the outbox, in one
   *  transaction (FR-001, FR-017). */
  record(where: TenantScoped<NewRecordedDecision>): Promise<RecordedDecision>;

  /**
   * Single-use consumption (T023): `consumed_at IS NULL` else `DecisionAlreadyConsumedError`,
   * `proposal_digest === presentedDigest` else `DigestMismatchError` — checked in that order,
   * atomically against concurrent consumption of the same decision — then sets `consumed_at`.
   * Throws `NotFoundError` (`@healer/shared`) for a decision id that does not resolve under this
   * tenant.
   */
  consume(where: TenantScoped<ConsumeDecisionInput>): Promise<void>;
}
