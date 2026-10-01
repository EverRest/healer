import { describe, expect, it } from 'vitest';
import { NotFoundError, TenantContext, type TenantScoped } from '@healer/shared';
import {
  ApprovalNotPendingError,
  type ApprovalRequestRepository,
  type ApprovalRequestSummary,
} from '../../domain/approval-request-repository.js';
import type { ApprovalCallbackPort } from '../../domain/approval-callback-port.js';
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
  constructor(
    private readonly pending: readonly ApprovalRequestSummary[],
    private readonly failOn: ReadonlySet<string> = new Set(),
  ) {}
  async findPendingWithStaleEpoch(): Promise<readonly ApprovalRequestSummary[]> {
    return this.pending;
  }
  async revoke(
    where: TenantScoped<{ readonly id: string; readonly decisionId: string }>,
  ): Promise<ApprovalRequestSummary> {
    if (this.failOn.has(where.id)) throw new ApprovalNotPendingError(where.id);
    this.revoked.push(where.id);
    const found = this.pending.find((a) => a.id === where.id);
    if (found === undefined) throw new NotFoundError('approval_request');
    return { ...found, state: 'revoked' };
  }
}

class FakeCallback implements ApprovalCallbackPort {
  delivered: string[] = [];
  async deliver(input: { readonly approvalId: string }): Promise<void> {
    this.delivered.push(input.approvalId);
  }
}

describe('sweepRevokedApprovals (T045, R-07, quickstart 14)', () => {
  it('revokes every pending request with a stale epoch and delivers the callback for each', async () => {
    const approvals = new FakeApprovalRepo([approval({ id: 'a1' }), approval({ id: 'a2' })]);
    const callback = new FakeCallback();
    const result = await sweepRevokedApprovals(
      { approvals, autonomyEpochs: new FakeEpochRepo(1n) },
      callback,
      CONTEXT,
    );
    expect(result.revoked).toHaveLength(2);
    expect(result.skipped).toBe(0);
    expect(approvals.revoked).toEqual(['a1', 'a2']);
    expect(callback.delivered).toEqual(['a1', 'a2']);
  });

  it('nothing to sweep when no request has a stale epoch', async () => {
    const approvals = new FakeApprovalRepo([]);
    const result = await sweepRevokedApprovals(
      { approvals, autonomyEpochs: new FakeEpochRepo(0n) },
      new FakeCallback(),
      CONTEXT,
    );
    expect(result.revoked).toEqual([]);
    expect(result.skipped).toBe(0);
  });

  it('a request resolved or expired between read and write is skipped, not failed', async () => {
    const approvals = new FakeApprovalRepo(
      [approval({ id: 'a1' }), approval({ id: 'a2' })],
      new Set(['a1']),
    );
    const callback = new FakeCallback();
    const result = await sweepRevokedApprovals(
      { approvals, autonomyEpochs: new FakeEpochRepo(1n) },
      callback,
      CONTEXT,
    );
    expect(result.skipped).toBe(1);
    expect(result.revoked.map((r) => r.id)).toEqual(['a2']);
    expect(callback.delivered).toEqual(['a2']);
  });

  it('a genuine failure is collected and raised as AggregateError, not silently dropped', async () => {
    class FailingApprovalRepo extends FakeApprovalRepo {
      override async revoke(): Promise<ApprovalRequestSummary> {
        throw new Error('boom');
      }
    }
    const approvals = new FailingApprovalRepo([approval({ id: 'a1' })]);
    await expect(
      sweepRevokedApprovals(
        { approvals, autonomyEpochs: new FakeEpochRepo(1n) },
        new FakeCallback(),
        CONTEXT,
      ),
    ).rejects.toThrow(AggregateError);
  });
});
