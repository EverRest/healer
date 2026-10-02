import { HealerError, type TenantScoped } from '@healer/shared';
import type { ApprovalSummary } from './approval-summary.js';
import type { NewAuditEntry } from './audit-entry.js';
import type { NewRecordedDecision } from './policy-decision-repository.js';

/** The fields the revocation sweep (T045) needs from a pending `approval_request` — not the full
 *  `ApprovalRequest` shape Phase 7's `RequestApproval`/`ResolveApproval` will read/write. */
export interface ApprovalRequestSummary {
  readonly id: string;
  readonly decisionId: string;
  readonly workflowRunId: string;
  readonly autonomyEpoch: bigint;
  readonly state: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';
}

/** One `approval_request`, whole (T070-T075): what `GET /approvals` and the approver read. */
export interface ApprovalRequest extends ApprovalRequestSummary {
  readonly summary: ApprovalSummary;
  readonly evidenceIds: readonly string[];
  readonly expiresAt: Date;
  /** The human, for `approved` and `rejected` (FR-017). */
  readonly resolvedBy?: string;
  readonly resolvedAt?: Date;
  /** The rule set version of the decision this request was issued for — "against which policy
   *  version" a human decided (FR-017, US5 scenario 3). Read from the immutable decision, so it
   *  cannot drift from what the approver was shown. */
  readonly rulesetVersion: number;
}

/** The locked row a guard sees, inside the repository's transaction. */
export interface LockedApproval {
  readonly id: string;
  readonly state: ApprovalRequestSummary['state'];
  readonly expiresAt: Date;
  readonly autonomyEpoch: bigint;
}

/** Runs inside the repository's transaction, after the approval row is locked `FOR UPDATE` and
 *  the tenant's current epoch is read — so the check and the write it guards see one state
 *  (READ COMMITTED read-then-write needs the lock, not a check before the transaction). */
export type RedemptionGuard = (approval: LockedApproval, currentEpoch: bigint, now: Date) => void;

export interface NewApprovalRequest {
  readonly id: string;
  readonly decisionId: string;
  readonly workflowRunId: string;
  readonly summary: ApprovalSummary;
  readonly evidenceIds: readonly string[];
  /** The expiry asked for; the effective one is projected onto the run's deadline. */
  readonly requestedExpiresAt?: Date;
  readonly now: Date;
  readonly auditEntry: TenantScoped<NewAuditEntry>;
}

export interface ResolveApprovalRecord {
  readonly id: string;
  readonly resolution: 'approved' | 'rejected';
  readonly resolvedBy: string;
  readonly resolvedAt: Date;
  readonly assertRedeemable: RedemptionGuard;
  readonly auditEntry: TenantScoped<NewAuditEntry>;
}

export interface ExpireApprovalRecord {
  readonly id: string;
  readonly now: Date;
  readonly assertDue: (approval: LockedApproval, now: Date) => void;
  /** The `DENY(APPROVAL_EXPIRED)` decision, written in the same transaction as the expiry. */
  readonly lapseDecision: TenantScoped<NewRecordedDecision>;
  readonly auditEntry: TenantScoped<NewAuditEntry>;
}

export interface ApprovalListFilter {
  readonly state?: ApprovalRequestSummary['state'];
  readonly issueId?: string;
}

/** `revoke()` on a request that is no longer `pending` (resolved or expired concurrently between
 *  the sweep's read and its write) — this is the sweep working, not failing, mirroring
 *  `markStaleIssues`'s "no longer a candidate" treatment. */
export class ApprovalNotPendingError extends HealerError {
  constructor(readonly approvalId: string) {
    super('PRECONDITION_FAILED', `approval request ${approvalId} is no longer pending`);
    this.name = 'ApprovalNotPendingError';
  }
}

/**
 * `policy.approval_request` (T045; the full lifecycle — `RequestApproval`, `ResolveApproval`,
 * `ExpireApproval` — is Phase 7, out of scope here). This is only what the revocation sweep
 * needs: find requests whose recorded epoch has gone stale, and move one to `revoked`.
 */
export interface ApprovalRequestRepository {
  /** Every `pending` request for this tenant whose recorded `autonomy_epoch` no longer matches
   *  the tenant's current one — the epoch bump (T043) already invalidates these at redemption
   *  (R-07); this is what makes the invalidation *prompt* rather than only correct (contracts/
   *  evaluation.md: "the epoch makes the guarantee correct even if the sweep never runs; the
   *  sweep makes it prompt"). */
  findPendingWithStaleEpoch(
    where: TenantScoped<{ readonly currentEpoch: bigint }>,
  ): Promise<readonly ApprovalRequestSummary[]>;

  /** Moves the request to `revoked` and, in the same transaction, invalidates the
   *  `policy_decision` it was issued for (`invalidated_reason = 'epoch_bump'`) — mirrors the
   *  state diagram's `pending --grant revoked--> revoked --> run to needs_human, DENY recorded`
   *  (data-model.md). Throws `ApprovalNotPendingError` if the request already resolved or
   *  expired since it was read; `NotFoundError` for an id that does not resolve under this
   *  tenant. Never touches a decision whose `invalidated_reason`/`consumed_at` is already set —
   *  the same idempotent-on-already-terminal posture `consume()` takes. */
  revoke(
    where: TenantScoped<{ readonly id: string; readonly decisionId: string }>,
  ): Promise<ApprovalRequestSummary>;
}

/**
 * T070-T075: the request/resolve/expire lifecycle, separate from the revocation sweep's slice
 * above so each caller depends only on what it uses. Both are implemented by
 * `PrismaApprovalRequestRepository`.
 */
export interface ApprovalLifecycleRepository {
  /** T070: creates the request and parks the run on it, in one transaction — locks the run,
   *  projects `expires_at` onto its `deadline_at` (T073), records the tenant's current epoch,
   *  issues the run's `approval` callback row, audits and publishes `ApprovalRequested`.
   *  Idempotent on `decisionId` (unique): a repeat returns the existing request unchanged. */
  request(where: TenantScoped<NewApprovalRequest>): Promise<ApprovalRequest>;

  /** T074: locks the request, runs the redemption guard (pending, not lapsed, epoch current),
   *  then records the resolution, the human, the audit entry and the callback delivery. */
  resolve(where: TenantScoped<ResolveApprovalRecord>): Promise<ApprovalRequest>;

  /** T073: locks the request, checks it is pending and due, then — one transaction — marks it
   *  `expired`, invalidates its decision, records the `DENY(APPROVAL_EXPIRED)` decision, moves a
   *  live run to `needs_human` and delivers the callback. Exactly one of `resolve` and `expire`
   *  wins a race: both lock the same row and the loser sees a non-pending state. */
  expire(where: TenantScoped<ExpireApprovalRecord>): Promise<ApprovalRequest>;

  findById(where: TenantScoped<{ readonly id: string }>): Promise<ApprovalRequest | null>;
  list(where: TenantScoped<ApprovalListFilter>): Promise<readonly ApprovalRequest[]>;
  /** `pending` requests whose `expires_at` has passed — what the deadline tick expires. */
  findDue(where: TenantScoped<{ readonly now: Date }>): Promise<readonly ApprovalRequest[]>;
}
