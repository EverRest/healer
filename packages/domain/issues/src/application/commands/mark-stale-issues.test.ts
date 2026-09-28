import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import { markStaleIssues, STALE_WINDOW_MS } from './mark-stale-issues.js';
import type { Issue } from '../../domain/issue.js';
import type { IssueRepository, StaleCandidate } from '../../domain/repository.js';
import { ConcurrentModificationError } from '../../domain/state-machine.js';

const TENANT_ID = '00000000-0000-0000-8000-0000000000ab';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const NOW = new Date('2026-06-01T00:00:00Z');

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    tenantId: TENANT_ID,
    kind: 'monitoring_alert',
    componentId: null,
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

function repoWith(candidates: readonly StaleCandidate[]): IssueRepository & {
  readonly markStaleCalls: { tenantId: string; id: string; at: Date; lastProgressAt: Date }[];
  readonly idleBefore: Date[];
} {
  const markStaleCalls: { tenantId: string; id: string; at: Date; lastProgressAt: Date }[] = [];
  const idleBefore: Date[] = [];
  return {
    markStaleCalls,
    idleBefore,
    create: () => Promise.reject(new Error('not used in this test')),
    findById: () => Promise.reject(new Error('not used in this test')),
    findOpenByFingerprint: () => Promise.reject(new Error('not used in this test')),
    findMostRecentlyResolvedByFingerprint: () => Promise.reject(new Error('not used in this test')),
    // A job that reaches for `transition` at all is a job that can resolve an issue (R-11).
    transition: () => Promise.reject(new Error('markStaleIssues must never transition an issue')),
    recordOccurrence: () => Promise.reject(new Error('not used in this test')),
    findOpenCorrelationCandidates: () => Promise.reject(new Error('not used in this test')),
    correlate: () => Promise.reject(new Error('not used in this test')),
    list: () => Promise.reject(new Error('not used in this test')),
    findRelationships: () => Promise.reject(new Error('not used in this test')),
    findStaleCandidates: async (where) => {
      idleBefore.push(where.idleBefore);
      return candidates;
    },
    markStale: async (where) => {
      markStaleCalls.push(where);
      return { ...issue({ id: where.id }), state: 'stale', staleAt: where.at };
    },
  };
}

describe('markStaleIssues (001 T051, FR-017, R-11)', () => {
  it('marks every candidate stale, carrying the progress time the query measured', async () => {
    const lastProgressAt = new Date('2026-01-01T00:00:00Z');
    const repo = repoWith([
      { issue: issue({ id: 'issue-1' }), lastProgressAt },
      { issue: issue({ id: 'issue-2' }), lastProgressAt },
    ]);

    const marked = await markStaleIssues(repo, CONTEXT, NOW);

    expect(repo.markStaleCalls).toEqual([
      { tenantId: TENANT_ID, id: 'issue-1', at: NOW, lastProgressAt },
      { tenantId: TENANT_ID, id: 'issue-2', at: NOW, lastProgressAt },
    ]);
    expect(marked.map((i) => i.state)).toEqual(['stale', 'stale']);
  });

  it('asks for issues idle since exactly one stale window before now', async () => {
    const repo = repoWith([]);

    await markStaleIssues(repo, CONTEXT, NOW);

    expect(repo.idleBefore).toEqual([new Date(NOW.getTime() - STALE_WINDOW_MS)]);
  });

  it('skips an issue that made progress after it was read, and still marks the rest', async () => {
    const lastProgressAt = new Date('2026-01-01T00:00:00Z');
    const repo = repoWith([
      { issue: issue({ id: 'busy' }), lastProgressAt },
      { issue: issue({ id: 'idle' }), lastProgressAt },
    ]);
    const markStale = repo.markStale;
    repo.markStale = (where) =>
      where.id === 'busy'
        ? Promise.reject(new ConcurrentModificationError('Issue'))
        : markStale(where);

    const marked = await markStaleIssues(repo, CONTEXT, NOW);

    expect(marked.map((i) => i.id)).toEqual(['idle']);
  });

  it('lets any other failure through — a broken sweep must be visible, not swallowed', async () => {
    const repo = repoWith([{ issue: issue(), lastProgressAt: new Date('2026-01-01T00:00:00Z') }]);
    repo.markStale = () => Promise.reject(new Error('database is down'));

    await expect(markStaleIssues(repo, CONTEXT, NOW)).rejects.toThrow('database is down');
  });

  it('writes nothing when no issue is idle', async () => {
    const repo = repoWith([]);

    expect(await markStaleIssues(repo, CONTEXT, NOW)).toEqual([]);
    expect(repo.markStaleCalls).toEqual([]);
  });
});
