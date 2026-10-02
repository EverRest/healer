import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import type {
  ApprovalRequest,
  ApprovalLifecycleRepository,
  NewApprovalRequest,
} from '../../domain/approval-request-repository.js';
import type {
  PolicyDecisionRepository,
  StoredDecision,
} from '../../domain/policy-decision-repository.js';
import { buildDecisionInput } from '../../domain/test-support/fixtures.js';
import { requestApproval } from './request-approval.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000f1');
const NOW = new Date('2026-10-01T12:00:00Z');

function decision(overrides: Partial<StoredDecision> = {}): StoredDecision {
  return {
    id: 'd1',
    proposalDigest: 'digest',
    outcome: 'require_approval',
    reasonCodes: ['APPROVAL_REQUIRED'],
    rulesetVersion: 7,
    matchedRuleKeys: ['r'],
    ceilingApplied: false,
    evaluatedAt: NOW,
    actionKey: 'change.open_pull_request',
    workflowRunId: 'run-1',
    issueId: 'issue-1',
    decisionInput: buildDecisionInput(),
    budgetState: { consumed: 0, limit: 100, declaredMaxCost: 1, degradationStep: 0 },
    ...overrides,
  };
}

function decisions(found: StoredDecision | null): PolicyDecisionRepository {
  return {
    async findById() {
      return found;
    },
  } as unknown as PolicyDecisionRepository;
}

class FakeApprovals {
  requested: TenantScoped<NewApprovalRequest>[] = [];
  async request(where: TenantScoped<NewApprovalRequest>): Promise<ApprovalRequest> {
    this.requested.push(where);
    return {
      id: where.id,
      decisionId: where.decisionId,
      workflowRunId: where.workflowRunId,
      autonomyEpoch: 0n,
      state: 'pending',
      summary: where.summary,
      evidenceIds: where.evidenceIds,
      expiresAt: where.requestedExpiresAt ?? NOW,
      rulesetVersion: 7,
    };
  }
}

function repos(approvals: FakeApprovals, found: StoredDecision | null) {
  return {
    approvals: approvals as unknown as ApprovalLifecycleRepository,
    decisions: decisions(found),
  };
}

describe('requestApproval (T070)', () => {
  it('builds the summary from the stored decision and parks the run it is bound to', async () => {
    const approvals = new FakeApprovals();
    await requestApproval(
      repos(approvals, decision()),
      CONTEXT,
      { decisionId: 'd1', evidenceIds: ['e1'], expiresAt: new Date(NOW.getTime() + 1000) },
      () => NOW,
    );
    const call = approvals.requested[0]!;
    expect(call.workflowRunId).toBe('run-1');
    expect(call.summary.proposedAction).toBe('change.open_pull_request');
    expect(call.evidenceIds).toEqual(['e1']);
    expect(call.auditEntry).toMatchObject({
      actorType: 'system',
      action: 'policy.request_approval',
      policyDecisionId: 'd1',
    });
  });

  it('reads the clock by default', async () => {
    const approvals = new FakeApprovals();
    await requestApproval(repos(approvals, decision()), CONTEXT, {
      decisionId: 'd1',
      evidenceIds: [],
    });
    expect(approvals.requested[0]!.now.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('refuses a decision that is not bound to a workflow run (nothing to park)', async () => {
    const approvals = new FakeApprovals();
    const { workflowRunId: _omit, ...unbound } = decision();
    await expect(
      requestApproval(
        repos(approvals, unbound as StoredDecision),
        CONTEXT,
        { decisionId: 'd1', evidenceIds: [] },
        () => NOW,
      ),
    ).rejects.toThrow(/not bound to a workflow run/);
    expect(approvals.requested).toHaveLength(0);
  });

  it('refuses a decision that is not require_approval, and an unknown decision', async () => {
    const approvals = new FakeApprovals();
    await expect(
      requestApproval(
        repos(approvals, decision({ outcome: 'allow' })),
        CONTEXT,
        { decisionId: 'd1', evidenceIds: [] },
        () => NOW,
      ),
    ).rejects.toThrow(/require_approval/);
    await expect(
      requestApproval(
        repos(approvals, null),
        CONTEXT,
        { decisionId: 'd1', evidenceIds: [] },
        () => NOW,
      ),
    ).rejects.toThrow(/PolicyDecision/);
    expect(approvals.requested).toHaveLength(0);
  });
});
