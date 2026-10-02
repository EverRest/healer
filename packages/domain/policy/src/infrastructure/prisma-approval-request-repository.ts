import type { TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import {
  ApprovalNotPendingError,
  type ApprovalRequestRepository,
  type ApprovalRequestSummary,
} from '../domain/approval-request-repository.js';
import { lockApproval } from './prisma-approval-lifecycle-repository.js';

interface ApprovalRow {
  readonly id: string;
  readonly decisionId: string;
  readonly workflowRunId: string;
  readonly autonomyEpoch: bigint;
  readonly state: string;
}

function toDomain(row: ApprovalRow): ApprovalRequestSummary {
  return {
    id: row.id,
    decisionId: row.decisionId,
    workflowRunId: row.workflowRunId,
    autonomyEpoch: row.autonomyEpoch,
    state: row.state as ApprovalRequestSummary['state'],
  };
}

/** `policy.approval_request`, the slice the revocation sweep needs (T045). `revoke()` moves the
 *  request to `revoked` and invalidates the `policy_decision` it was issued for in one
 *  transaction — directly, via this same `PrismaClient`, the same move
 *  `PrismaAutonomyGrantRepository.revoke()` makes for `autonomy_epoch`: both rows change or
 *  neither does, which is what stops "approval says revoked, decision still says allow-pending"
 *  from ever being an observable state. */
export class PrismaApprovalRequestRepository implements ApprovalRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findPendingWithStaleEpoch(
    where: TenantScoped<{ readonly currentEpoch: bigint }>,
  ): Promise<readonly ApprovalRequestSummary[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        tenantId: where.tenantId,
        state: 'pending',
        autonomyEpoch: { not: where.currentEpoch },
      },
    });
    return rows.map(toDomain);
  }

  async revoke(
    where: TenantScoped<{ readonly id: string; readonly decisionId: string }>,
  ): Promise<ApprovalRequestSummary> {
    return this.prisma.$transaction(async (tx) => {
      // Under the row lock `ResolveApproval` and `ExpireApproval` also take: without it this
      // read-then-write could overwrite an approval a human committed an instant earlier.
      const { locked } = await lockApproval(tx, where.tenantId, where.id);
      if (locked.state !== 'pending') throw new ApprovalNotPendingError(where.id);

      const resolvedAt = new Date();
      const updated = await tx.approvalRequest.update({
        where: { id: where.id },
        data: { state: 'revoked', resolvedAt },
      });

      // Idempotent on an already-terminal decision — same posture `consume()` takes: this never
      // overwrites a `consumed_at`/`invalidated_reason` that is already set.
      await tx.policyDecision.updateMany({
        where: {
          id: where.decisionId,
          tenantId: where.tenantId,
          consumedAt: null,
          invalidatedReason: null,
        },
        data: { invalidatedReason: 'epoch_bump' },
      });

      return toDomain(updated);
    });
  }
}
