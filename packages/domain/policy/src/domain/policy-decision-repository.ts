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
  /** Set for a decision that charges (declares a cost): the digest of the caller's request with
   *  the resolved fields and the instant removed — the idempotency key of the charge (T060). */
  readonly requestKey?: string;
}

export interface ConsumeDecisionInput {
  readonly decisionId: string;
  readonly presentedDigest: string;
}

/** A decision as `GET /policy/decisions` and `GET /policy/decisions/{decisionId}` read it
 *  (FR-002, FR-017) — everything `record()` wrote, not only what it returned: the recorded
 *  `decisionInput` and `budgetState` a replay needs, the binding, and the two terminal fields
 *  (`consumedAt`, `invalidatedReason`) that only ever change after the fact. */
export interface StoredDecision extends RecordedDecision, DecisionBinding {
  readonly actionKey: string;
  readonly targetRef?: string;
  readonly fingerprint?: string;
  readonly decisionInput: DecisionInput;
  readonly budgetState: BudgetState;
  readonly consumedAt?: Date;
  readonly invalidatedReason?: string;
}

/** `GET /policy/decisions` query filters (contracts/openapi.yaml). */
export interface DecisionListFilter {
  readonly issueId?: string;
  readonly actionKey?: string;
  readonly outcome?: Decision['outcome'];
  readonly since?: Date;
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
    super(
      'DIGEST_MISMATCH',
      `presented digest does not match decision ${decisionId}'s proposal digest`,
    );
    this.name = 'DigestMismatchError';
  }
}

/** Refuses `consume()` for a decision that was never an `allow` (batch 9 C1(a), review finding):
 *  the typed evaluation surface is supposed to be "the only way to obtain an ALLOW" (R-14) —
 *  before this fix, `consume()` checked only `consumed_at`/`proposal_digest`, so a `deny` or
 *  `require_approval` decision consumed cleanly and an executor calling it would proceed as if
 *  permitted. `reason: 'outcome'` is a decision whose recorded `outcome !== 'allow'`; `reason:
 *  'invalidated'` is a decision with a non-null `invalidated_reason` — the CHECK constraint
 *  already forbids `consumed_at` and `invalidated_reason` both being set, so without this refusal
 *  the raw `UPDATE` would hit that constraint as an unhandled Postgres error instead of a typed
 *  one. One class covers both: to the caller, either reason means "this decision never authorized
 *  the action," which is the fact that matters. */
export class DecisionNotAllowedError extends HealerError {
  constructor(
    readonly decisionId: string,
    readonly reason: 'outcome' | 'invalidated',
  ) {
    super(
      'DECISION_NOT_ALLOWED',
      reason === 'outcome'
        ? `policy decision ${decisionId} did not resolve to allow and cannot be consumed`
        : `policy decision ${decisionId} has been invalidated and cannot be consumed`,
    );
    this.name = 'DecisionNotAllowedError';
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
   * Single-use consumption (T023, hardened batch 9 C1(a)): checked in this order, atomically
   * against concurrent consumption of the same decision, then sets `consumed_at` —
   * `consumed_at IS NULL` else `DecisionAlreadyConsumedError`; `invalidated_reason IS NULL` else
   * `DecisionNotAllowedError('invalidated')`; `outcome === 'allow'` else
   * `DecisionNotAllowedError('outcome')`; `proposal_digest === presentedDigest` else
   * `DigestMismatchError`. The outcome/invalidated checks come before the digest check
   * deliberately: whether this decision ever authorized anything is a fact about the decision
   * itself, independent of what the caller presents. Throws `NotFoundError` (`@healer/shared`)
   * for a decision id that does not resolve under this tenant.
   */
  consume(where: TenantScoped<ConsumeDecisionInput>): Promise<void>;

  /** One decision for this tenant, or null — including another tenant's decision id, which must
   *  read as "not found," never as a lookup that could distinguish "exists" from "doesn't"
   *  (FR-018). */
  findById(where: TenantScoped<{ readonly id: string }>): Promise<StoredDecision | null>;

  /** Recorded decisions for this tenant, newest first, narrowed by whichever filters are given
   *  (`GET /policy/decisions`, FR-002). */
  list(where: TenantScoped<DecisionListFilter>): Promise<readonly StoredDecision[]>;
}
