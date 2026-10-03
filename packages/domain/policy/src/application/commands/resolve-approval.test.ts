import { describe, expect, it } from 'vitest';
import { NotFoundError, TenantContext, type TenantScoped } from '@healer/shared';
import {
  ApprovalNotPendingError,
  type ApprovalRequest,
  type ApprovalLifecycleRepository,
  type ResolveApprovalRecord,
} from '../../domain/approval-request-repository.js';
import { StaleAutonomyEpochError } from '../../domain/check-autonomy-epoch.js';
import { buildApprovalSummary } from '../../domain/approval-summary.js';
import { buildDecisionInput } from '../../domain/test-support/fixtures.js';
import { resolveApproval } from './resolve-approval.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000f1');
const NOW = new Date('2026-10-01T12:00:00Z');

function pendingApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'a1',
    decisionId: 'd1',
    workflowRunId: 'run-1',
    autonomyEpoch: 2n,
    state: 'pending',
    summary: buildApprovalSummary({
      id: 'd1',
      proposalDigest: 'x',
      outcome: 'require_approval',
      reasonCodes: ['APPROVAL_REQUIRED'],
      rulesetVersion: 7,
      matchedRuleKeys: [],
      ceilingApplied: false,
      evaluatedAt: NOW,
      actionKey: 'change.open_pull_request',
      decisionInput: buildDecisionInput(),
      budgetState: { consumed: 0, limit: 1, declaredMaxCost: 0, degradationStep: 0 },
    }),
    evidenceIds: [],
    expiresAt: new Date(NOW.getTime() + 60_000),
    rulesetVersion: 7,
    ...overrides,
  };
}

/** Behaves like the Prisma repo: runs the supplied guard against the stored row and the
 *  tenant's *current* epoch, and only writes when the guard passes. */
class FakeApprovals {
  writes: TenantScoped<ResolveApprovalRecord>[] = [];
  constructor(
    private row: ApprovalRequest | null,
    private currentEpoch: bigint,
  ) {}
  async findById(): Promise<ApprovalRequest | null> {
    return this.row;
  }
  async resolve(where: TenantScoped<ResolveApprovalRecord>): Promise<ApprovalRequest> {
    if (this.row === null) throw new NotFoundError('approval_request');
    where.assertRedeemable(this.row, this.currentEpoch, where.resolvedAt);
    this.writes.push(where);
    this.row = { ...this.row, state: where.resolution, resolvedBy: where.resolvedBy };
    return this.row;
  }
}

const run = (repo: FakeApprovals, resolution: 'approved' | 'rejected' = 'approved') =>
  resolveApproval(
    { approvals: repo as unknown as ApprovalLifecycleRepository },
    CONTEXT,
    { approvalId: 'a1', resolution, resolvedBy: 'alice' },
    () => NOW,
  );

describe('resolveApproval (T074, FR-017)', () => {
  it('records which human decided and against which ruleset version, in the audit entry', async () => {
    const repo = new FakeApprovals(pendingApproval(), 2n);
    const resolved = await run(repo);
    expect(resolved.state).toBe('approved');
    expect(resolved.resolvedBy).toBe('alice');
    expect(repo.writes[0]!.auditEntry).toMatchObject({
      actorType: 'human',
      actorRef: 'alice',
      action: 'policy.resolve_approval',
      policyDecisionId: 'd1',
    });
    expect(repo.writes[0]!.auditEntry.reason).toContain('ruleset version 7');
  });

  it('reads the clock by default, and carries an optional note into the audit reason', async () => {
    const repo = new FakeApprovals(
      pendingApproval({ expiresAt: new Date('2099-01-01T00:00:00Z') }),
      2n,
    );
    await resolveApproval({ approvals: repo as unknown as ApprovalLifecycleRepository }, CONTEXT, {
      approvalId: 'a1',
      resolution: 'approved',
      resolvedBy: 'alice',
      note: 'checked the diff',
    });
    expect(repo.writes[0]!.auditEntry.reason).toContain(': checked the diff');
  });

  it('a rejection is recorded the same way', async () => {
    const repo = new FakeApprovals(pendingApproval(), 2n);
    expect((await run(repo, 'rejected')).state).toBe('rejected');
  });

  it('T044 wiring: revoked after the request was issued, sweep disabled -> STALE_AUTONOMY_EPOCH and nothing is written', async () => {
    const repo = new FakeApprovals(pendingApproval({ autonomyEpoch: 2n }), 3n);
    await expect(run(repo)).rejects.toThrow(StaleAutonomyEpochError);
    expect(repo.writes).toHaveLength(0);
  });

  it('T044 wiring: with the sweep run (state revoked) the refusal is APPROVAL_NOT_PENDING', async () => {
    const repo = new FakeApprovals(pendingApproval({ autonomyEpoch: 2n, state: 'revoked' }), 3n);
    await expect(run(repo)).rejects.toThrow(ApprovalNotPendingError);
  });

  it('a request past expires_at is not approvable even before the tick fires (SC-007)', async () => {
    const repo = new FakeApprovals(pendingApproval({ expiresAt: NOW }), 2n);
    await expect(run(repo)).rejects.toThrow(ApprovalNotPendingError);
  });

  it('an unknown approval is not found', async () => {
    await expect(run(new FakeApprovals(null, 0n))).rejects.toThrow(NotFoundError);
  });
});
