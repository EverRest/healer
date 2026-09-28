import { describe, expect, it } from 'vitest';
import { NotFoundError, TenantContext } from '@healer/shared';
import { markStaleIssues, STALE_WINDOW_MS, type StalenessRepository } from './mark-stale-issues.js';
import type { Issue } from '../../domain/issue.js';
import type { StaleCandidate } from '../../domain/repository.js';
import {
  ConcurrentModificationError,
  InvalidIssueTransitionError,
} from '../../domain/state-machine.js';

const TENANT_ID = '00000000-0000-0000-8000-0000000000ab';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const NOW = new Date('2026-06-01T00:00:00Z');
const LAST_PROGRESS = new Date('2026-01-01T00:00:00Z');

function issue(id: string): Issue {
  return {
    id,
    tenantId: TENANT_ID,
    kind: 'monitoring_alert',
    componentId: null,
    environment: 'prod',
    severity: 'high',
    state: 'stale',
    fingerprint: 'fp1',
    rulesetVersion: 1,
    occurrenceCount: 1n,
    firstSeenAt: LAST_PROGRESS,
    lastSeenAt: LAST_PROGRESS,
    staleAt: NOW,
    resolvedAt: null,
    createdAt: LAST_PROGRESS,
  };
}

function candidates(...ids: string[]): StaleCandidate[] {
  return ids.map((id) => ({ id, lastProgressAt: LAST_PROGRESS }));
}

/**
 * Only the two methods the sweep is typed to take — there is no `transition` on this stub to
 * reject, because `StalenessRepository` has none to call. That the object type-checks at all is the
 * proof the sweep cannot reach the general transition API (R-11).
 */
function repoWith(
  found: readonly StaleCandidate[],
  markStale?: StalenessRepository['markStale'],
): StalenessRepository & {
  readonly markStaleCalls: { tenantId: string; id: string; at: Date; lastProgressAt: Date }[];
  readonly idleBefore: Date[];
} {
  const markStaleCalls: { tenantId: string; id: string; at: Date; lastProgressAt: Date }[] = [];
  const idleBefore: Date[] = [];
  return {
    markStaleCalls,
    idleBefore,
    findStaleCandidates: async (where) => {
      idleBefore.push(where.idleBefore);
      return found;
    },
    markStale:
      markStale ??
      (async (where) => {
        markStaleCalls.push(where);
        return issue(where.id);
      }),
  };
}

describe('markStaleIssues (001 T051, FR-017, R-11)', () => {
  it('marks every candidate stale, carrying the progress time the query measured', async () => {
    const repo = repoWith(candidates('issue-1', 'issue-2'));

    const result = await markStaleIssues(repo, CONTEXT, NOW);

    expect(repo.markStaleCalls).toEqual([
      { tenantId: TENANT_ID, id: 'issue-1', at: NOW, lastProgressAt: LAST_PROGRESS },
      { tenantId: TENANT_ID, id: 'issue-2', at: NOW, lastProgressAt: LAST_PROGRESS },
    ]);
    expect(result.marked.map((i) => i.id)).toEqual(['issue-1', 'issue-2']);
    expect(result.skipped).toBe(0);
  });

  it('asks for issues idle since exactly one stale window before now', async () => {
    const repo = repoWith([]);

    await markStaleIssues(repo, CONTEXT, NOW);

    expect(repo.idleBefore).toEqual([new Date(NOW.getTime() - STALE_WINDOW_MS)]);
  });

  it('writes nothing when no issue is idle', async () => {
    const repo = repoWith([]);

    expect(await markStaleIssues(repo, CONTEXT, NOW)).toEqual({ marked: [], skipped: 0 });
    expect(repo.markStaleCalls).toEqual([]);
  });

  it.each([
    ['made progress after it was read', new ConcurrentModificationError('Issue')],
    [
      'stopped being a candidate (resolved, merged, already stale)',
      new InvalidIssueTransitionError('resolved -> stale is not a declared transition'),
    ],
    ['was deleted', new NotFoundError('Issue')],
  ])('skips, counts, and moves on from an issue that %s', async (_why, error) => {
    const repo = repoWith(candidates('gone', 'idle'), async (where) => {
      if (where.id === 'gone') throw error;
      return issue(where.id);
    });

    const result = await markStaleIssues(repo, CONTEXT, NOW);

    expect(result.marked.map((i) => i.id)).toEqual(['idle']);
    expect(result.skipped).toBe(1);
  });

  it('finishes the sweep past an unexpected failure, then fails the job with every error', async () => {
    const boom = new Error('database is down');
    const repo = repoWith(candidates('bad', 'good'), async (where) => {
      if (where.id === 'bad') throw boom;
      return issue(where.id);
    });

    const failure = await markStaleIssues(repo, CONTEXT, NOW).catch((error: unknown) => error);

    // The job fails — a broken sweep must be visible, not swallowed — but 'good' was still marked:
    // one deterministic failure must not block every issue behind it on every run.
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([boom]);
  });
});
