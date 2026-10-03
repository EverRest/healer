import { HealerError } from '@healer/shared';
import {
  DecisionAlreadyConsumedError,
  DecisionNotAllowedError,
} from './policy-decision-repository.js';
import {
  ApprovalNotPendingError,
  type LockedApproval,
  type RedemptionGuard,
} from './approval-request-repository.js';
import { checkAutonomyEpoch } from './check-autonomy-epoch.js';
import type { NewRecordedDecision, StoredDecision } from './policy-decision-repository.js';
import type { ReasonCode } from './reason-code.js';

/** `APPROVAL_EXPIRED` is declared once, in `REASON_CODES`; this is a typed reference to it, not a
 *  second declaration of the member. */
const APPROVAL_EXPIRED: ReasonCode = 'APPROVAL_EXPIRED';

/** A request is only issued for a decision that is still live: not consumed, not invalidated
 *  (an epoch bump, an earlier lapse). Checked by the command and again, on the fresh row, inside
 *  the repository's transaction. */
export function assertRequestable(decision: {
  readonly id: string;
  readonly consumedAt?: Date | null;
  readonly invalidatedReason?: string | null;
}): void {
  if (decision.consumedAt != null) throw new DecisionAlreadyConsumedError(decision.id);
  if (decision.invalidatedReason != null) {
    throw new DecisionNotAllowedError(decision.id, 'invalidated');
  }
}

/** A tick fired before `expires_at`. Nothing expires; the next tick will. */
export class ApprovalNotDueError extends HealerError {
  constructor(readonly approvalId: string) {
    super('PRECONDITION_FAILED', `approval request ${approvalId} is not due to expire yet`);
    this.name = 'ApprovalNotDueError';
  }
}

/** Neither a requested expiry nor a run deadline exists, so no tick would ever fire the expiry
 *  (R-09): the request is refused rather than created unexpirable. */
export class ApprovalWithoutDeadlineError extends HealerError {
  constructor() {
    super(
      'VALIDATION',
      'approval refused: no expiry requested and the run has no deadline, so nothing would fire its expiry',
    );
    this.name = 'ApprovalWithoutDeadlineError';
  }
}

/**
 * `expires_at` is projected onto the run's `deadline_at` (R-09, 012 T013): never later than it,
 * so an expiry always has a tick that will fire it (data-model.md invariant). The earlier of the
 * two wins; the repository then writes the result back as the run's deadline.
 */
export function projectExpiry(requested: Date | undefined, runDeadline: Date | undefined): Date {
  if (requested !== undefined && runDeadline !== undefined) {
    return requested.getTime() <= runDeadline.getTime() ? requested : runDeadline;
  }
  const only = requested ?? runDeadline;
  if (only === undefined) throw new ApprovalWithoutDeadlineError();
  return only;
}

/**
 * The redemption-time check (R-07, FR-007, FR-016, T044/T074), run by `ResolveApproval` inside
 * the transaction that holds the row lock. Order matters: a request that is no longer `pending`
 * (resolved, expired, or `revoked` by the sweep) is `APPROVAL_NOT_PENDING`; a lapsed request is
 * the same even before its tick fires — an expired request never becomes an approval (SC-007);
 * only then the epoch, which is what holds when the sweep never ran (`STALE_AUTONOMY_EPOCH`).
 */
export const assertRedeemable: RedemptionGuard = (approval, currentEpoch, now) => {
  if (approval.state !== 'pending' || now.getTime() >= approval.expiresAt.getTime()) {
    throw new ApprovalNotPendingError(approval.id);
  }
  checkAutonomyEpoch(approval, currentEpoch);
};

/** `ExpireApproval`'s guard: only a pending request whose time has come. */
export function assertDue(approval: LockedApproval, now: Date): void {
  if (approval.state !== 'pending') throw new ApprovalNotPendingError(approval.id);
  if (now.getTime() < approval.expiresAt.getTime()) throw new ApprovalNotDueError(approval.id);
}

/**
 * The decision recorded for a lapse (FR-016, SC-007; R-09: "recording the lapse as an explicit
 * `DENY` rather than as absence keeps SC-001's reconciliation total"). Same run, state, digest,
 * input and ruleset version as the decision that asked for approval; no rule matched because none
 * was evaluated — the lapse is a fact, not a fold — so replay skips it (`reason_codes` carries
 * `APPROVAL_EXPIRED`).
 */
export function buildLapseDecision(
  original: StoredDecision,
  id: string,
  now: Date,
): NewRecordedDecision {
  return {
    id,
    decision: {
      outcome: 'deny',
      reasonCodes: [APPROVAL_EXPIRED],
      rulesetVersion: original.rulesetVersion,
      matchedRuleKeys: [],
      ceilingApplied: false,
      evaluatedAt: now,
    },
    decisionInput: original.decisionInput,
    proposalDigest: original.proposalDigest,
    budgetState: original.budgetState,
    actionKey: original.actionKey,
    ...(original.targetRef !== undefined ? { targetRef: original.targetRef } : {}),
    ...(original.fingerprint !== undefined ? { fingerprint: original.fingerprint } : {}),
    binding: {
      ...(original.issueId !== undefined ? { issueId: original.issueId } : {}),
      ...(original.workflowRunId !== undefined ? { workflowRunId: original.workflowRunId } : {}),
      ...(original.workflowState !== undefined ? { workflowState: original.workflowState } : {}),
    },
  };
}
