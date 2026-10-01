import { HealerError, type TenantScoped } from '@healer/shared';

/** The fields the revocation sweep (T045) needs from a pending `approval_request` — not the full
 *  `ApprovalRequest` shape Phase 7's `RequestApproval`/`ResolveApproval` will read/write. */
export interface ApprovalRequestSummary {
  readonly id: string;
  readonly decisionId: string;
  readonly workflowRunId: string;
  readonly autonomyEpoch: bigint;
  readonly state: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';
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
