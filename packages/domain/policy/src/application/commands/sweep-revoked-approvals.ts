import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import {
  ApprovalNotPendingError,
  type ApprovalRequestRepository,
  type ApprovalRequestSummary,
} from '../../domain/approval-request-repository.js';
import type { AutonomyEpochRepository } from '../../domain/autonomy-epoch-repository.js';

export const REVOKE_APPROVAL_AUDIT_ACTION = 'policy.revoke_approval';

export interface SweepRevokedApprovalsResult {
  readonly revoked: readonly ApprovalRequestSummary[];
  /** Requests that stopped being pending between the read and the write — resolved or expired
   *  concurrently. That is the sweep working, not failing (mirrors `markStaleIssues`). Only
   *  `ApprovalNotPendingError` counts: a missing run, callback or request is a failure. */
  readonly skipped: number;
}

/**
 * The revocation sweep (T045, R-07, quickstart 14): resolves every outstanding `pending`
 * approval whose recorded epoch has gone stale to `revoked`. The repository's `revoke` does, in
 * the same transaction, everything the revocation means — invalidates the decision, delivers the
 * approval's callback, moves a live run to `needs_human` and writes the audit entry — so a failed
 * delivery rolls the revocation back and the next sweep retries it, and a parked run reaches
 * `needs_human` immediately rather than at its own expiry.
 *
 * Correctness never depends on this running (quickstart 15): the epoch check at redemption
 * (T043/T044) already refuses a stale approval with no sweep involved — this only makes the
 * refusal *prompt*. Any failure that is not "no longer pending" is collected and the sweep still
 * processes the rest, then raises `AggregateError` at the end (a retry is safe).
 *
 * No production caller schedules this yet (QUESTIONS.md, "002 Phase 7").
 */
export async function sweepRevokedApprovals(
  repos: {
    readonly approvals: ApprovalRequestRepository;
    readonly autonomyEpochs: AutonomyEpochRepository;
  },
  context: TenantContext,
  now: () => Date = () => new Date(),
): Promise<SweepRevokedApprovalsResult> {
  const currentEpoch = await repos.autonomyEpochs.current(scope(context, {}));
  const stale = await repos.approvals.findPendingWithStaleEpoch(scope(context, { currentEpoch }));
  const at = now();

  const revoked: ApprovalRequestSummary[] = [];
  const failures: unknown[] = [];
  let skipped = 0;

  for (const approval of stale) {
    try {
      revoked.push(
        await repos.approvals.revoke(
          scope(context, {
            id: approval.id,
            decisionId: approval.decisionId,
            now: at,
            auditEntry: scope(context, {
              id: randomUUID(),
              actorType: 'system' as const,
              actorRef: 'revocation-sweep',
              action: REVOKE_APPROVAL_AUDIT_ACTION,
              targetType: 'approval_request',
              targetId: approval.id,
              reason: `autonomy epoch moved past ${approval.autonomyEpoch}; request revoked, run moved to needs_human`,
              evidenceIds: [],
              policyDecisionId: approval.decisionId,
              outcome: 'ok',
            }),
          }),
        ),
      );
    } catch (error) {
      if (error instanceof ApprovalNotPendingError) skipped += 1;
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
