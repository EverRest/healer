import { describe, expect, it } from 'vitest';
import { NotFoundError, TenantContext, type TenantScoped } from '@healer/shared';
import {
  ApprovalNotPendingError,
  type ApprovalRequest,
  type ApprovalLifecycleRepository,
  type ExpireApprovalRecord,
} from '../../domain/approval-request-repository.js';
import { buildApprovalSummary } from '../../domain/approval-summary.js';
import type {
  PolicyDecisionRepository,
  StoredDecision,
} from '../../domain/policy-decision-repository.js';
import { buildDecisionInput } from '../../domain/test-support/fixtures.js';
import { expireApproval, expireDueApprovals } from './expire-approval.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000f1');
const EXPIRES = new Date('2026-10-01T12:00:00Z');
const AFTER = new Date(EXPIRES.getTime() + 1);

const original: StoredDecision = {
  id: 'd1',
  proposalDigest: 'digest-1',
  outcome: 'require_approval',
  reasonCodes: ['APPROVAL_REQUIRED'],
  rulesetVersion: 7,
  matchedRuleKeys: ['r'],
  ceilingApplied: false,
  evaluatedAt: new Date('2026-10-01T00:00:00Z'),
  actionKey: 'change.open_pull_request',
  workflowRunId: 'run-1',
  workflowState: 'awaiting_approval',
  issueId: 'issue-1',
  decisionInput: buildDecisionInput(),
  budgetState: { consumed: 1, limit: 100, declaredMaxCost: 1, degradationStep: 0 },
};

function approval(id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    decisionId: 'd1',
    workflowRunId: 'run-1',
    autonomyEpoch: 0n,
    state: 'pending',
    summary: buildApprovalSummary(original),
    evidenceIds: [],
    expiresAt: EXPIRES,
    rulesetVersion: 7,
    ...overrides,
  };
}

class FakeApprovals {
  expired: TenantScoped<ExpireApprovalRecord>[] = [];
  constructor(
    private rows: ApprovalRequest[],
    private failOn = new Set<string>(),
  ) {}
  async findById(where: { id: string }): Promise<ApprovalRequest | null> {
    return this.rows.find((r) => r.id === where.id) ?? null;
  }
  async findDue(): Promise<readonly ApprovalRequest[]> {
    return this.rows.filter((r) => r.state === 'pending');
  }
  async expire(where: TenantScoped<ExpireApprovalRecord>): Promise<ApprovalRequest> {
    const row = this.rows.find((r) => r.id === where.id);
    if (row === undefined) throw new NotFoundError('approval_request');
    if (this.failOn.has(where.id)) throw new ApprovalNotPendingError(where.id);
    where.assertDue(row, where.now);
    this.expired.push(where);
    return { ...row, state: 'expired' };
  }
}

const decisions = {
  async findById() {
    return original;
  },
} as unknown as PolicyDecisionRepository;

const reposOf = (approvals: unknown) => ({
  approvals: approvals as ApprovalLifecycleRepository,
  decisions,
});

describe('expireApproval (T072, T073, FR-016, SC-007)', () => {
  it('records DENY with APPROVAL_EXPIRED bound to the same run, ruleset version and digest', async () => {
    const approvals = new FakeApprovals([approval('a1')]);
    const result = await expireApproval(
      reposOf(approvals),
      CONTEXT,
      { approvalId: 'a1' },
      () => AFTER,
    );
    expect(result.state).toBe('expired');
    const lapse = approvals.expired[0]!.lapseDecision;
    expect(lapse.decision).toMatchObject({
      outcome: 'deny',
      reasonCodes: ['APPROVAL_EXPIRED'],
      rulesetVersion: 7,
      matchedRuleKeys: [],
      evaluatedAt: AFTER,
    });
    expect(lapse.proposalDigest).toBe('digest-1');
    expect(lapse.binding).toEqual({
      issueId: 'issue-1',
      workflowRunId: 'run-1',
      workflowState: 'awaiting_approval',
    });
    expect(approvals.expired[0]!.auditEntry).toMatchObject({
      actorType: 'system',
      action: 'policy.expire_approval',
      policyDecisionId: lapse.id,
    });
  });

  it('reads the clock by default (single request and tick)', async () => {
    const long = new FakeApprovals([
      approval('a1', { expiresAt: new Date('2000-01-01T00:00:00Z') }),
    ]);
    await expireApproval(reposOf(long), CONTEXT, { approvalId: 'a1' });
    const tick = new FakeApprovals([
      approval('a2', { expiresAt: new Date('2000-01-01T00:00:00Z') }),
    ]);
    const result = await expireDueApprovals(reposOf(tick), CONTEXT);
    expect(result.expired.map((a) => a.id)).toEqual(['a2']);
  });

  it('a tick that fires before expires_at expires nothing', async () => {
    const approvals = new FakeApprovals([approval('a1')]);
    await expect(
      expireApproval(
        reposOf(approvals),
        CONTEXT,
        { approvalId: 'a1' },
        () => new Date(EXPIRES.getTime() - 1),
      ),
    ).rejects.toThrow(/not due/);
    expect(approvals.expired).toHaveLength(0);
  });

  it('an unknown approval is not found', async () => {
    await expect(
      expireApproval(reposOf(new FakeApprovals([])), CONTEXT, { approvalId: 'nope' }, () => AFTER),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('expireDueApprovals (the deadline tick)', () => {
  it('expires every due request and skips one that was resolved concurrently', async () => {
    const approvals = new FakeApprovals(
      [approval('a1'), approval('a2'), approval('a3')],
      new Set(['a2']),
    );
    const result = await expireDueApprovals(reposOf(approvals), CONTEXT, () => AFTER);
    expect(result.expired.map((a) => a.id)).toEqual(['a1', 'a3']);
    expect(result.skipped).toBe(1);
  });

  it('collects any other failure, finishes the rest, then raises', async () => {
    const approvals = new FakeApprovals([approval('a1'), approval('a2')]);
    const broken = Object.assign(approvals, {
      async expire(where: TenantScoped<ExpireApprovalRecord>): Promise<ApprovalRequest> {
        if (where.id === 'a1') throw new Error('db down');
        return approval('a2', { state: 'expired' });
      },
    });
    await expect(expireDueApprovals(reposOf(broken), CONTEXT, () => AFTER)).rejects.toThrow(
      AggregateError,
    );
  });

  it('H2: a NotFoundError mid-tick (missing decision, run or callback) is a failure, not a skip', async () => {
    const approvals = new FakeApprovals([approval('a1')]);
    const missing = Object.assign(approvals, {
      async expire(): Promise<ApprovalRequest> {
        throw new NotFoundError('workflow_callback');
      },
    });
    await expect(expireDueApprovals(reposOf(missing), CONTEXT, () => AFTER)).rejects.toThrow(
      AggregateError,
    );
  });
});
