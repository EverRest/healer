import { describe, expect, it } from 'vitest';
import { NotFoundError, TenantContext, type TenantScoped } from '@healer/shared';
import {
  ApprovalNotPendingError,
  type ApprovalRequestRepository,
  type ApprovalRequestSummary,
} from '../../domain/approval-request-repository.js';
import type { NewAuditEntry } from '../../domain/audit-entry.js';
import type { AutonomyEpochRepository } from '../../domain/autonomy-epoch-repository.js';
import { sweepRevokedApprovals } from './sweep-revoked-approvals.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000f1');

function approval(overrides: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary {
  return {
    id: 'approval-1',
    decisionId: 'decision-1',
    workflowRunId: 'run-1',
    autonomyEpoch: 0n,
    state: 'pending',
    ...overrides,
  };
}

class FakeEpochRepo implements AutonomyEpochRepository {
  constructor(private readonly epoch: bigint) {}
  async current(): Promise<bigint> {
    return this.epoch;
  }
  async bump(): Promise<bigint> {
    throw new Error('not used by this test');
  }
}

class FakeApprovalRepo implements ApprovalRequestRepository {
  revoked: string[] = [];
  audits: TenantScoped<NewAuditEntry>[] = [];
  constructor(
    private readonly pending: readonly ApprovalRequestSummary[],
    private readonly failWith = new Map<string, Error>(),
  ) {}
  async findPendingWithStaleEpoch(): Promise<readonly ApprovalRequestSummary[]> {
    return this.pending;
  }
  async revoke(
    where: TenantScoped<{
      readonly id: string;
      readonly decisionId: string;
      readonly now: Date;
      readonly auditEntry: TenantScoped<NewAuditEntry>;
    }>,
  ): Promise<ApprovalRequestSummary> {
    const failure = this.failWith.get(where.id);
    if (failure !== undefined) throw failure;
    this.revoked.push(where.id);
    this.audits.push(where.auditEntry);
    const found = this.pending.find((a) => a.id === where.id);
    if (found === undefined) throw new NotFoundError('approval_request');
    return { ...found, state: 'revoked' };
  }
}

describe('sweepRevokedApprovals (T045, R-07, quickstart 14)', () => {
  it('revokes every pending request with a stale epoch, auditing each (delivery is inside revoke)', async () => {
    const approvals = new FakeApprovalRepo([approval({ id: 'a1' }), approval({ id: 'a2' })]);
    const result = await sweepRevokedApprovals(
      { approvals, autonomyEpochs: new FakeEpochRepo(1n) },
      CONTEXT,
    );
    expect(result.revoked).toHaveLength(2);
    expect(result.skipped).toBe(0);
    expect(approvals.revoked).toEqual(['a1', 'a2']);
    expect(approvals.audits[0]).toMatchObject({
      actorType: 'system',
      action: 'policy.revoke_approval',
      targetId: 'a1',
      policyDecisionId: 'decision-1',
    });
  });

  it('nothing to sweep when no request has a stale epoch', async () => {
    const result = await sweepRevokedApprovals(
      { approvals: new FakeApprovalRepo([]), autonomyEpochs: new FakeEpochRepo(0n) },
      CONTEXT,
      () => new Date('2026-10-01T00:00:00Z'),
    );
    expect(result.revoked).toEqual([]);
    expect(result.skipped).toBe(0);
  });

  it('a request resolved or expired between read and write is skipped, not failed', async () => {
    const approvals = new FakeApprovalRepo(
      [approval({ id: 'a1' }), approval({ id: 'a2' })],
      new Map([['a1', new ApprovalNotPendingError('a1')]]),
    );
    const result = await sweepRevokedApprovals(
      { approvals, autonomyEpochs: new FakeEpochRepo(1n) },
      CONTEXT,
    );
    expect(result.skipped).toBe(1);
    expect(result.revoked.map((r) => r.id)).toEqual(['a2']);
  });

  it('H2: a NotFoundError (missing run, callback or request) is a failure, never a skip', async () => {
    const approvals = new FakeApprovalRepo(
      [approval({ id: 'a1' })],
      new Map([['a1', new NotFoundError('workflow_callback')]]),
    );
    await expect(
      sweepRevokedApprovals({ approvals, autonomyEpochs: new FakeEpochRepo(1n) }, CONTEXT),
    ).rejects.toThrow(AggregateError);
  });

  it('a genuine failure is collected and raised as AggregateError, not silently dropped', async () => {
    const approvals = new FakeApprovalRepo(
      [approval({ id: 'a1' })],
      new Map([['a1', new Error('boom')]]),
    );
    await expect(
      sweepRevokedApprovals({ approvals, autonomyEpochs: new FakeEpochRepo(1n) }, CONTEXT),
    ).rejects.toThrow(AggregateError);
  });
});
