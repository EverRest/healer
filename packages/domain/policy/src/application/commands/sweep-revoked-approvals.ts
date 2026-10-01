import { NotFoundError, scope, type TenantContext } from '@healer/shared';
import {
  ApprovalNotPendingError,
  type ApprovalRequestRepository,
  type ApprovalRequestSummary,
} from '../../domain/approval-request-repository.js';
import type { ApprovalCallbackPort } from '../../domain/approval-callback-port.js';
import type { AutonomyEpochRepository } from '../../domain/autonomy-epoch-repository.js';

export interface SweepRevokedApprovalsResult {
  readonly revoked: readonly ApprovalRequestSummary[];
  /** Requests that stopped being pending between the read and the write — resolved or expired
   *  concurrently. That is the sweep working, not failing (mirrors `markStaleIssues`). */
  readonly skipped: number;
}

/**
 * The revocation sweep (T045, R-07, quickstart 14): resolves every outstanding `pending`
 * approval whose recorded epoch has gone stale to `revoked` and delivers the `approval`
 * callback, so a parked run reaches `needs_human` immediately rather than at its own expiry.
 *
 * Correctness never depends on this running (quickstart 15): the epoch check at redemption
 * (T043/T044) already refuses a stale approval with no sweep involved — this only makes the
 * refusal *prompt*. Any failure that is not "no longer pending" is collected and the sweep still
 * processes the rest, then raises `AggregateError` at the end (same posture as
 * `markStaleIssues` — a retry is safe, and no candidate silently blocks every one behind it).
 */
export async function sweepRevokedApprovals(
  repos: {
    readonly approvals: ApprovalRequestRepository;
    readonly autonomyEpochs: AutonomyEpochRepository;
  },
  callback: ApprovalCallbackPort,
  context: TenantContext,
): Promise<SweepRevokedApprovalsResult> {
  const currentEpoch = await repos.autonomyEpochs.current(scope(context, {}));
  const stale = await repos.approvals.findPendingWithStaleEpoch(scope(context, { currentEpoch }));

  const revoked: ApprovalRequestSummary[] = [];
  const failures: unknown[] = [];
  let skipped = 0;

  for (const approval of stale) {
    try {
      const result = await repos.approvals.revoke(
        scope(context, { id: approval.id, decisionId: approval.decisionId }),
      );
      revoked.push(result);
      await callback.deliver({
        tenantId: context.tenantId,
        workflowRunId: approval.workflowRunId,
        approvalId: approval.id,
      });
    } catch (error) {
      if (error instanceof ApprovalNotPendingError || error instanceof NotFoundError) skipped += 1;
      else failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `revocation sweep: ${failures.length} of ${stale.length} candidates failed (${revoked.length} revoked, ${skipped} skipped)`,
    );
  }

  return { revoked, skipped };
}
