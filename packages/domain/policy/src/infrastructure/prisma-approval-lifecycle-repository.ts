import {
  createLogger,
  currentCorrelationId,
  NotFoundError,
  type TenantScoped,
} from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import { ZodError } from 'zod';
import { assertRequestable, projectExpiry } from '../domain/approval-lifecycle.js';
import { checkAutonomyEpoch } from '../domain/check-autonomy-epoch.js';
import {
  ApprovalAlreadyPendingError,
  type ApprovalLifecycleRepository,
  type ApprovalListFilter,
  type ApprovalRequest,
  type DueApproval,
  type ExpireApprovalRecord,
  type LockedApproval,
  type NewApprovalRequest,
  type ResolveApprovalRecord,
} from '../domain/approval-request-repository.js';
import { approvalSummarySchema } from '../domain/approval-summary.js';
import {
  approvalExpiredEvent,
  approvalRequestedEvent,
  approvalResolvedEvent,
  policyDecisionRecordedEvent,
} from '../domain/events.js';
import {
  ApprovalRunTerminalError,
  clearAwaiting,
  deliverApprovalCallback,
  lockRun,
  moveRunToNeedsHuman,
  parkRun,
} from './approval-run-effects.js';
import { recordAuditEntry } from './record-audit-entry.js';

function assertCorrelated(): void {
  if (currentCorrelationId() === undefined) {
    throw new Error(
      'approval commands publish events: call inside a correlated scope (withCorrelation)',
    );
  }
}

const LOG = createLogger({ serviceName: 'policy' });

const WITH_DECISION = { decision: { select: { rulesetVersion: true } } } as const;

interface ApprovalRow {
  readonly id: string;
  readonly decisionId: string;
  readonly workflowRunId: string;
  readonly summary: unknown;
  readonly evidenceIds: string[];
  readonly autonomyEpoch: bigint;
  readonly expiresAt: Date;
  readonly state: string;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly decision: { readonly rulesetVersion: number };
}

function toDomain(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    decisionId: row.decisionId,
    workflowRunId: row.workflowRunId,
    autonomyEpoch: row.autonomyEpoch,
    state: row.state as ApprovalRequest['state'],
    // Parsed, not cast: a stored summary that no longer fits the closed shape must not be shown.
    summary: approvalSummarySchema.parse(row.summary),
    evidenceIds: row.evidenceIds,
    expiresAt: row.expiresAt,
    ...(row.resolvedBy !== null ? { resolvedBy: row.resolvedBy } : {}),
    ...(row.resolvedAt !== null ? { resolvedAt: row.resolvedAt } : {}),
    rulesetVersion: row.decision.rulesetVersion,
  };
}

interface LockedApprovalRow {
  readonly id: string;
  readonly state: string;
  readonly expires_at: Date;
  readonly autonomy_epoch: bigint;
  readonly workflow_run_id: string;
  readonly decision_id: string;
}

/** `FOR UPDATE` on the request: `ResolveApproval`, `ExpireApproval` and the revocation sweep all
 *  read its state and then write it, so each holds this lock — READ COMMITTED would otherwise let
 *  two of them both see `pending`. The loser sees the winner's state and refuses. */
export async function lockApproval(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const rows = await tx.$queryRaw<LockedApprovalRow[]>`
    SELECT id, state::text AS state, expires_at, autonomy_epoch, workflow_run_id, decision_id
    FROM "policy"."approval_request"
    WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid
    FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('approval_request');
  const locked: LockedApproval = {
    id: row.id,
    state: row.state as LockedApproval['state'],
    expiresAt: row.expires_at,
    autonomyEpoch: row.autonomy_epoch,
  };
  return { locked, runId: row.workflow_run_id, decisionId: row.decision_id };
}

/** The tenant's current epoch, read `FOR SHARE` so a revocation's bump (an UPDATE of this row)
 *  cannot commit between this read and the resolution it guards. Absent row = epoch 0. */
async function currentEpochShared(tx: Prisma.TransactionClient, tenantId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<{ epoch: bigint }[]>`
    SELECT epoch FROM "policy"."autonomy_epoch"
    WHERE tenant_id = ${tenantId}::uuid
    FOR SHARE`;
  return rows[0]?.epoch ?? 0n;
}

/**
 * `policy.approval_request` lifecycle (T070-T075): request, resolve, expire and the reads. Each
 * write is one transaction holding the row locks it reads under, and each audits (FR-017) and
 * publishes through the outbox in that same transaction.
 */
export class PrismaApprovalLifecycleRepository implements ApprovalLifecycleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async request(where: TenantScoped<NewApprovalRequest>): Promise<ApprovalRequest> {
    assertCorrelated();
    const { tenantId } = where;
    return this.prisma.$transaction(async (tx) => {
      // The run lock comes first and serialises concurrent requests for the same run, so the
      // idempotency read below cannot miss a request committed an instant earlier.
      const run = await lockRun(tx, tenantId, where.workflowRunId);
      const existing = await tx.approvalRequest.findFirst({
        where: { decisionId: where.decisionId, tenantId },
        include: WITH_DECISION,
      });
      if (existing !== null) return toDomain(existing);
      if (run.terminalState !== null) throw new ApprovalRunTerminalError(where.workflowRunId);

      // One outstanding approval per run: a second would share (and could consume or orphan) the
      // run's single deadline and awaiting marker. A run waiting on something else is not ours to
      // overwrite either; one whose marker is a *resolved* approval's may be re-parked.
      const pendingOnRun = await tx.approvalRequest.count({
        where: { tenantId, workflowRunId: where.workflowRunId, state: 'pending' },
      });
      if (pendingOnRun > 0 || (run.awaiting !== null && run.awaiting.kind !== 'approval')) {
        throw new ApprovalAlreadyPendingError(where.workflowRunId);
      }

      const decision = await tx.policyDecision.findFirst({
        where: { id: where.decisionId, tenantId },
      });
      if (decision === null) throw new NotFoundError('PolicyDecision');
      assertRequestable(decision);

      const evidenceIds = [...new Set(where.evidenceIds)];
      const found = await tx.evidence.count({
        where: {
          tenantId,
          id: { in: evidenceIds },
          ...(decision.issueId !== null ? { issueId: decision.issueId } : {}),
        },
      });
      if (found !== evidenceIds.length) throw new NotFoundError('evidence');

      const expiresAt = projectExpiry(where.requestedExpiresAt, run.deadlineAt ?? undefined);
      // The epoch the decision was made under must still be the current one, or a revocation has
      // happened since and this request would carry a post-revocation epoch it never held.
      checkAutonomyEpoch(
        { id: where.id, autonomyEpoch: where.autonomyEpoch },
        await currentEpochShared(tx, tenantId),
      );
      const created = await tx.approvalRequest.create({
        data: {
          id: where.id,
          tenantId,
          decisionId: where.decisionId,
          workflowRunId: where.workflowRunId,
          summary: where.summary as unknown as Prisma.InputJsonValue,
          evidenceIds,
          autonomyEpoch: where.autonomyEpoch,
          expiresAt,
          state: 'pending',
        },
        include: WITH_DECISION,
      });
      await parkRun(tx, { tenantId, runId: where.workflowRunId, approvalId: where.id, expiresAt });
      await recordAuditEntry(tx, where.auditEntry);
      await enqueue(
        new PrismaOutboxTransaction(tx),
        approvalRequestedEvent(tenantId, {
          approvalId: where.id,
          summary: where.summary,
          expiresAt,
        }),
      );
      return toDomain(created);
    });
  }

  async resolve(where: TenantScoped<ResolveApprovalRecord>): Promise<ApprovalRequest> {
    assertCorrelated();
    const { tenantId } = where;
    return this.prisma.$transaction(async (tx) => {
      const { locked, runId, decisionId } = await lockApproval(tx, tenantId, where.id);
      const epoch = await currentEpochShared(tx, tenantId);
      where.assertRedeemable(locked, epoch, where.resolvedAt);
      // Same lock order as `expire` (approval, then run). A terminal run has nothing left to resume.
      const run = await lockRun(tx, tenantId, runId);
      if (run.terminalState !== null) throw new ApprovalRunTerminalError(runId);

      const updated = await tx.approvalRequest.update({
        where: { id: where.id },
        data: {
          state: where.resolution,
          resolvedBy: where.resolvedBy,
          resolvedAt: where.resolvedAt,
        },
        include: WITH_DECISION,
      });
      await deliverApprovalCallback(tx, { tenantId, approvalId: where.id, now: where.resolvedAt });
      await clearAwaiting(tx, { runId });
      if (where.resolution === 'rejected') {
        // A rejection is final for this proposal: its decision never becomes consumable, and the
        // run stops for a human (nothing proceeds by default, and there is no second approver).
        await tx.policyDecision.updateMany({
          where: { id: decisionId, tenantId, consumedAt: null, invalidatedReason: null },
          data: { invalidatedReason: 'approval_rejected' },
        });
        await moveRunToNeedsHuman(tx, {
          tenantId,
          runId,
          now: where.resolvedAt,
          cause: 'human',
          actorRef: where.resolvedBy,
        });
      }
      await recordAuditEntry(tx, where.auditEntry);
      await enqueue(
        new PrismaOutboxTransaction(tx),
        approvalResolvedEvent(tenantId, {
          approvalId: where.id,
          resolution: where.resolution,
          resolvedBy: where.resolvedBy,
        }),
      );
      return toDomain(updated);
    });
  }

  async expire(where: TenantScoped<ExpireApprovalRecord>): Promise<ApprovalRequest> {
    assertCorrelated();
    const { tenantId } = where;
    const lapse = where.lapseDecision;
    return this.prisma.$transaction(async (tx) => {
      const { locked, runId, decisionId } = await lockApproval(tx, tenantId, where.id);
      where.assertDue(locked, where.now);

      const updated = await tx.approvalRequest.update({
        where: { id: where.id },
        data: { state: 'expired', resolvedAt: where.now },
        include: WITH_DECISION,
      });
      // The original decision never becomes consumable; a lapse is not an approval.
      await tx.policyDecision.updateMany({
        where: { id: decisionId, tenantId, consumedAt: null, invalidatedReason: null },
        data: { invalidatedReason: 'approval_expired' },
      });
      await tx.policyDecision.create({
        data: {
          id: lapse.id,
          tenantId,
          issueId: lapse.binding.issueId ?? null,
          workflowRunId: lapse.binding.workflowRunId ?? null,
          workflowState: lapse.binding.workflowState ?? null,
          actionKey: lapse.actionKey,
          targetRef: lapse.targetRef ?? null,
          fingerprint: lapse.fingerprint ?? null,
          proposalDigest: lapse.proposalDigest,
          decisionInput: lapse.decisionInput as unknown as Prisma.InputJsonValue,
          rulesetVersion: lapse.decision.rulesetVersion,
          matchedRuleKeys: [...lapse.decision.matchedRuleKeys],
          outcome: lapse.decision.outcome,
          reasonCodes: [...lapse.decision.reasonCodes],
          ceilingApplied: lapse.decision.ceilingApplied,
          budgetState: lapse.budgetState as unknown as Prisma.InputJsonValue,
          evaluatedAt: lapse.decision.evaluatedAt,
        },
      });
      await moveRunToNeedsHuman(tx, {
        tenantId,
        runId,
        now: where.now,
        cause: 'timeout',
        actorRef: 'policy.expire_approval',
      });
      await deliverApprovalCallback(tx, { tenantId, approvalId: where.id, now: where.now });
      await recordAuditEntry(tx, where.auditEntry);
      const outbox = new PrismaOutboxTransaction(tx);
      await enqueue(
        outbox,
        policyDecisionRecordedEvent(tenantId, {
          decisionId: lapse.id,
          actionKey: lapse.actionKey,
          outcome: lapse.decision.outcome,
          rulesetVersion: lapse.decision.rulesetVersion,
          reasonCodes: lapse.decision.reasonCodes,
          ...(lapse.binding.issueId !== undefined ? { issueId: lapse.binding.issueId } : {}),
        }),
      );
      await enqueue(
        outbox,
        approvalExpiredEvent(tenantId, { approvalId: where.id, workflowRunId: runId }),
      );
      return toDomain(updated);
    });
  }

  async findById(where: TenantScoped<{ readonly id: string }>): Promise<ApprovalRequest | null> {
    try {
      const row = await this.prisma.approvalRequest.findFirst({
        where: { id: where.id, tenantId: where.tenantId },
        include: WITH_DECISION,
      });
      return row === null ? null : toDomain(row);
    } catch (error) {
      // A malformed (non-UUID) id fails Postgres's own cast (P2023): same answer as "not found".
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2023') {
        return null;
      }
      throw error;
    }
  }

  async list(where: TenantScoped<ApprovalListFilter>): Promise<readonly ApprovalRequest[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        tenantId: where.tenantId,
        ...(where.state !== undefined ? { state: where.state } : {}),
        ...(where.issueId !== undefined ? { decision: { issueId: where.issueId } } : {}),
      },
      include: WITH_DECISION,
      orderBy: { expiresAt: 'desc' },
    });
    // Per row, not all-or-nothing: one stored summary that no longer fits the closed shape must
    // not 500 the tenant's whole list. The row is skipped *loudly* (structured error log with its
    // id and the failing paths, never the content), and `findById` still raises for that row.
    const parsed: ApprovalRequest[] = [];
    for (const row of rows) {
      try {
        parsed.push(toDomain(row));
      } catch (error) {
        LOG.error(
          {
            tenantId: where.tenantId,
            approvalId: row.id,
            paths: error instanceof ZodError ? error.issues.map((i) => i.path.join('.')) : [],
          },
          'approval_request.summary failed validation; row omitted from list',
        );
      }
    }
    return parsed;
  }

  async findDue(where: TenantScoped<{ readonly now: Date }>): Promise<readonly DueApproval[]> {
    // Ids and expiry only: the tick must not parse (and so cannot fail on) a stored summary.
    return this.prisma.approvalRequest.findMany({
      where: { tenantId: where.tenantId, state: 'pending', expiresAt: { lte: where.now } },
      select: { id: true, expiresAt: true },
      orderBy: { expiresAt: 'asc' },
    });
  }
}
