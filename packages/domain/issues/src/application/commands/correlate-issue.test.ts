import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import { correlateIssue } from './correlate-issue.js';
import { CORRELATION_WINDOW_MS } from '../../domain/correlation.js';
import type { Issue, IssueRelationship } from '../../domain/issue.js';
import type { IssueRepository } from '../../domain/repository.js';

const TENANT_ID = '00000000-0000-0000-8000-0000000000aa';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    tenantId: TENANT_ID,
    kind: 'monitoring_alert',
    componentId: 'component-1',
    environment: 'prod',
    severity: 'high',
    state: 'detected',
    fingerprint: 'fp1',
    rulesetVersion: 1,
    occurrenceCount: 1n,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    staleAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function repoWithCandidates(candidates: readonly Issue[]): IssueRepository & {
  correlateCalls: { id: string; otherId: string; rule: string }[];
} {
  const correlateCalls: { id: string; otherId: string; rule: string }[] = [];
  return {
    correlateCalls,
    create: () => Promise.reject(new Error('not used in this test')),
    findById: () => Promise.reject(new Error('not used in this test')),
    findOpenByFingerprint: () => Promise.reject(new Error('not used in this test')),
    findMostRecentlyResolvedByFingerprint: () => Promise.reject(new Error('not used in this test')),
    transition: () => Promise.reject(new Error('not used in this test')),
    recordOccurrence: () => Promise.reject(new Error('not used in this test')),
    findOpenCorrelationCandidates: async () => candidates,
    list: () => Promise.reject(new Error('not used in this test')),
    findRelationships: () => Promise.reject(new Error('not used in this test')),
    correlate: async (where) => {
      correlateCalls.push(where);
      return {
        id: 'rel-1',
        tenantId: TENANT_ID,
        issueId: where.id,
        otherIssueId: where.otherId,
        kind: 'related',
        rule: where.rule,
        createdAt: new Date(),
      } satisfies IssueRelationship;
    },
  };
}

describe('correlateIssue (001 T039, FR-020, quickstart 26)', () => {
  it('correlates with a candidate the repository returns that also passes the pure rule', async () => {
    const subject = issue({ id: 'a' });
    const candidate = issue({
      id: 'b',
      firstSeenAt: new Date(subject.firstSeenAt.getTime() + 1000),
    });
    const repo = repoWithCandidates([candidate]);

    const relationships = await correlateIssue(repo, CONTEXT, subject);

    expect(relationships).toHaveLength(1);
    expect(repo.correlateCalls).toEqual([
      { id: 'a', otherId: 'b', rule: 'component_environment_window', tenantId: TENANT_ID },
    ]);
  });

  it('skips a returned candidate outside the window — the pure rule is the final say, not the query alone', async () => {
    const subject = issue({ id: 'a' });
    const tooLate = issue({
      id: 'b',
      firstSeenAt: new Date(subject.firstSeenAt.getTime() + CORRELATION_WINDOW_MS + 1),
    });
    const repo = repoWithCandidates([tooLate]);

    expect(await correlateIssue(repo, CONTEXT, subject)).toEqual([]);
    expect(repo.correlateCalls).toEqual([]);
  });

  it('never queries at all when the subject has no componentId — dormant until 004 resolves one', async () => {
    const subject = issue({ componentId: null });
    let queried = false;
    const repo: IssueRepository = {
      create: () => Promise.reject(new Error('not used in this test')),
      findById: () => Promise.reject(new Error('not used in this test')),
      findOpenByFingerprint: () => Promise.reject(new Error('not used in this test')),
      findMostRecentlyResolvedByFingerprint: () =>
        Promise.reject(new Error('not used in this test')),
      transition: () => Promise.reject(new Error('not used in this test')),
      recordOccurrence: () => Promise.reject(new Error('not used in this test')),
      findOpenCorrelationCandidates: () => {
        queried = true;
        return Promise.resolve([]);
      },
      correlate: () => Promise.reject(new Error('not used in this test')),
      list: () => Promise.reject(new Error('not used in this test')),
      findRelationships: () => Promise.reject(new Error('not used in this test')),
    };

    expect(await correlateIssue(repo, CONTEXT, subject)).toEqual([]);
    expect(queried).toBe(false);
  });

  it('drops a correlate() no-op (already related) rather than counting it as a new relationship', async () => {
    const subject = issue({ id: 'a' });
    const candidate = issue({ id: 'b' });
    const repo = repoWithCandidates([candidate]);
    repo.correlate = async () => null;

    expect(await correlateIssue(repo, CONTEXT, subject)).toEqual([]);
  });
});
