import { describe, expect, it } from 'vitest';
import { currentCorrelationId } from '@healer/shared';
import { processSignalJob } from './process-signal-job.js';
import type {
  NormalisationRuleset,
  NormalisationRulesetRepository,
} from '../../domain/normalisation-ruleset.js';
import type { Issue } from '../../domain/issue.js';
import type { IssueRepository, NewIssue } from '../../domain/repository.js';
import type { SignalJobData } from '../../infrastructure/bullmq-signal-queue.js';

/**
 * `processSignalJob` (001 T025): the one place a queued job's plain-string, JSON-serialized
 * shape (`SignalJobData`) is turned back into a real `TenantContext`, a real `Signal` (`observedAt`
 * back to a `Date`) and a correlation scope, then handed to T018's `ingestSignal` — the actual
 * consumer T019's own comment named as "whatever drains this queue", which did not exist yet.
 */
const RULESET: NormalisationRuleset = {
  version: 1,
  rules: { stripPatterns: [] },
  publishedAt: new Date(),
  note: null,
};

function rulesetRepoStub(): NormalisationRulesetRepository {
  return {
    getByVersion: async () => RULESET,
    getLatest: async () => RULESET,
    publish: async () => RULESET,
  };
}

function issueRow(issue: TenantScopedNewIssue): Issue {
  return {
    id: issue.id,
    tenantId: issue.tenantId,
    kind: issue.kind,
    componentId: issue.componentId ?? null,
    environment: issue.environment,
    severity: issue.severity,
    state: 'detected',
    fingerprint: issue.fingerprint,
    rulesetVersion: issue.rulesetVersion,
    occurrenceCount: 1n,
    firstSeenAt: issue.firstSeenAt,
    lastSeenAt: issue.lastSeenAt,
    staleAt: null,
    resolvedAt: null,
    createdAt: new Date(),
  };
}

type TenantScopedNewIssue = NewIssue & { readonly tenantId: string };

function issueRepoRecording(created: Issue[], onCreate?: () => void): IssueRepository {
  return {
    findById: async () => null,
    findOpenByFingerprint: async () => null,
    findMostRecentlyResolvedByFingerprint: async () => null,
    transition: () => Promise.reject(new Error('not used in this test')),
    recordOccurrence: () => Promise.reject(new Error('not used in this test')),
    findOpenCorrelationCandidates: () => Promise.reject(new Error('not used in this test')),
    correlate: () => Promise.reject(new Error('not used in this test')),
    list: () => Promise.reject(new Error('not used in this test')),
    findRelationships: () => Promise.reject(new Error('not used in this test')),
    findStaleCandidates: () => Promise.reject(new Error('not used in this test')),
    markStale: () => Promise.reject(new Error('not used in this test')),
    create: async (issue) => {
      onCreate?.();
      const row = issueRow(issue);
      created.push(row);
      return row;
    },
  };
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000c1';

function jobData(overrides: Partial<SignalJobData['signal']> = {}): SignalJobData {
  return {
    tenantId: TENANT_ID,
    correlationId: 'corr-from-job',
    signal: {
      observedAt: '2026-01-01T00:00:00.000Z',
      component: 'checkout-service',
      environment: 'prod',
      errorSignature: { exceptionType: 'NullPointerException' },
      ...overrides,
    },
  };
}

describe('processSignalJob (001 T025)', () => {
  it('turns the serialized job back into a real Signal and ingests it', async () => {
    const created: Issue[] = [];
    const result = await processSignalJob(
      rulesetRepoStub(),
      issueRepoRecording(created),
      jobData(),
    );

    expect(result.created).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tenantId: TENANT_ID, environment: 'prod' });
    // observedAt survives the string round trip as a real Date, not the literal string.
    expect(created[0]?.firstSeenAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('runs the ingest inside the job’s own correlation id, not a fresh one', async () => {
    const created: Issue[] = [];
    let seenDuringIngest: string | undefined;
    await processSignalJob(
      rulesetRepoStub(),
      issueRepoRecording(created, () => {
        seenDuringIngest = currentCorrelationId();
      }),
      jobData(),
    );
    expect(seenDuringIngest).toBe('corr-from-job');
  });
});
