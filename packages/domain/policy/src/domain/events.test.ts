import { describe, expect, it } from 'vitest';
import { withCorrelation } from '@healer/shared';
import { enqueue, type OutboxRecord, type OutboxTransaction } from '@healer/events';
import {
  approvalExpiredEvent,
  approvalRequestedEvent,
  approvalResolvedEvent,
  autonomyGrantedEvent,
  autonomyRevokedEvent,
  budgetDegradedEvent,
  budgetExhaustedEvent,
  policyDecisionRecordedEvent,
  policyRulesetPublishedEvent,
} from './events.js';

const TENANT_ID = '0193a1f0-0000-7000-8000-0000000000f1';

/** Same fake as `@healer/events`'s own `outbox.test.ts` — proves each builder's shape reaches the
 * outbox write path (`enqueue`) with nothing more than the generic transaction interface. */
class FakeTransaction implements OutboxTransaction {
  staged: OutboxRecord[] = [];
  async insertOutbox(record: OutboxRecord): Promise<void> {
    this.staged.push(record);
  }
}

describe('policy outbox event builders (T016, contracts/evaluation.md)', () => {
  it('every builder requires an active correlation scope', () => {
    expect(() =>
      policyDecisionRecordedEvent(TENANT_ID, {
        decisionId: 'd1',
        actionKey: 'change.open_pull_request',
        outcome: 'allow',
        rulesetVersion: 1,
        reasonCodes: [],
      }),
    ).toThrow(/correlated scope/);
  });

  it('PolicyDecisionRecorded carries actionKey, outcome, rulesetVersion and reasonCodes', () =>
    withCorrelation('corr-1', async () => {
      const tx = new FakeTransaction();
      const event = policyDecisionRecordedEvent(TENANT_ID, {
        decisionId: 'decision-1',
        actionKey: 'deployment.rollback',
        outcome: 'require_approval',
        rulesetVersion: 3,
        reasonCodes: ['APPROVAL_REQUIRED'],
        issueId: 'issue-1',
      });
      await enqueue(tx, event);
      expect(tx.staged[0]).toMatchObject({
        name: 'PolicyDecisionRecorded',
        tenantId: TENANT_ID,
        subjectId: 'decision-1',
        correlationId: 'corr-1',
        payload: {
          actionKey: 'deployment.rollback',
          outcome: 'require_approval',
          rulesetVersion: 3,
          reasonCodes: ['APPROVAL_REQUIRED'],
          issueId: 'issue-1',
        },
      });
    }));

  it('ApprovalRequested carries the summary and expiry', () =>
    withCorrelation('corr-2', () => {
      const expiresAt = new Date('2026-02-01T00:00:00Z');
      const event = approvalRequestedEvent(TENANT_ID, {
        approvalId: 'approval-1',
        summary: { proposedAction: 'deployment.rollback' },
        expiresAt,
      });
      expect(event).toMatchObject({
        name: 'ApprovalRequested',
        subjectId: 'approval-1',
        payload: {
          summary: { proposedAction: 'deployment.rollback' },
          expiresAt: expiresAt.toISOString(),
        },
      });
    }));

  it('ApprovalResolved carries the resolution and resolver', () =>
    withCorrelation('corr-3', () => {
      const event = approvalResolvedEvent(TENANT_ID, {
        approvalId: 'approval-1',
        resolution: 'approved',
        resolvedBy: 'pavlo',
      });
      expect(event.payload).toEqual({ resolution: 'approved', resolvedBy: 'pavlo' });
    }));

  it('ApprovalExpired carries the workflow run id', () =>
    withCorrelation('corr-4', () => {
      const event = approvalExpiredEvent(TENANT_ID, {
        approvalId: 'approval-1',
        workflowRunId: 'run-1',
      });
      expect(event.payload).toEqual({ workflowRunId: 'run-1' });
    }));

  it('AutonomyGranted and AutonomyRevoked carry scope, actionKey, level and epoch', () =>
    withCorrelation('corr-5', () => {
      const params = {
        scope: { grantId: 'grant-1', environment: 'prod' },
        actionKey: 'change.open_pull_request',
        level: 2,
        epoch: 7n,
      };
      expect(autonomyGrantedEvent(TENANT_ID, params)).toMatchObject({
        name: 'AutonomyGranted',
        subjectId: 'grant-1',
        payload: { scope: { environment: 'prod' }, actionKey: params.actionKey, level: 2, epoch: '7' },
      });
      expect(autonomyRevokedEvent(TENANT_ID, params)).toMatchObject({ name: 'AutonomyRevoked' });
    }));

  it('BudgetDegraded carries the evidenceId, not degradation text', () =>
    withCorrelation('corr-6', () => {
      const event = budgetDegradedEvent(TENANT_ID, {
        scope: { scopeType: 'issue', scopeId: 'issue-1' },
        periodKey: '2026-02',
        step: 1,
        entryApplied: true,
        evidenceId: 'evidence-1',
      });
      expect(event.payload).toEqual({
        scopeType: 'issue',
        periodKey: '2026-02',
        step: 1,
        entryApplied: true,
        evidenceId: 'evidence-1',
      });
    }));

  it('BudgetExhausted carries consumed and limit', () =>
    withCorrelation('corr-7', () => {
      const event = budgetExhaustedEvent(TENANT_ID, {
        scope: { scopeType: 'tenant', scopeId: TENANT_ID },
        periodKey: '2026-02',
        consumed: 100,
        limit: 100,
      });
      expect(event.payload).toEqual({
        scopeType: 'tenant',
        periodKey: '2026-02',
        consumed: 100,
        limit: 100,
      });
    }));

  it('PolicyRulesetPublished carries version, digest and supersedesVersion', () =>
    withCorrelation('corr-8', () => {
      const event = policyRulesetPublishedEvent(TENANT_ID, {
        rulesetId: 'ruleset-2',
        version: 2,
        digest: 'digest-2',
        supersedesVersion: 1,
      });
      expect(event.payload).toEqual({ version: 2, digest: 'digest-2', supersedesVersion: 1 });
    }));
});
