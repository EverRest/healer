import { describe, expect, it } from 'vitest';
import { NotFoundError, TenantContext } from '@healer/shared';
import { closeIssue, type ClosingRepository } from './close-issue.js';
import type { Issue, IssueState } from '../../domain/issue.js';
import {
  ConcurrentModificationError,
  InvalidIssueTransitionError,
} from '../../domain/state-machine.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000ab');

function issue(state: IssueState): Issue {
  return {
    id: 'issue-1',
    tenantId: CONTEXT.tenantId,
    kind: 'monitoring_alert',
    componentId: null,
    environment: 'prod',
    severity: 'high',
    state,
    fingerprint: 'fp1',
    rulesetVersion: 1,
    occurrenceCount: 1n,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    staleAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/** `reads` are returned by `findById` in order (the last repeats); `transition` is recorded. */
function repoWith(reads: (Issue | null)[], transition?: ClosingRepository['transition']) {
  const calls: unknown[][] = [];
  let read = 0;
  const repo: ClosingRepository = {
    findById: async () => reads[Math.min(read++, reads.length - 1)] ?? null,
    transition:
      transition ??
      (async (_where, to, cause, actorRef, reason, audit) => {
        calls.push([to, cause, actorRef, reason, audit]);
        return issue('resolved');
      }),
  };
  return { repo, calls };
}

describe('closeIssue (001 T057, FR-021, quickstart 27)', () => {
  it('resolves a live issue as a human, carrying the actor and the reason', async () => {
    const { repo, calls } = repoWith([issue('investigating')]);
    const result = await closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'fixed by hand');
    expect(result).toMatchObject({ closed: true, issue: { state: 'resolved' } });
    expect(calls).toEqual([
      ['resolved', 'human', 'pavlo', 'fixed by hand', { action: 'issue.close' }],
    ]);
  });

  it('closing an already resolved issue is a no-op — nothing is written, the resolution stands', async () => {
    const { repo, calls } = repoWith([issue('resolved')]);
    const result = await closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'again');
    expect(result).toMatchObject({ closed: false, issue: { state: 'resolved' } });
    expect(calls).toEqual([]);
  });

  it('an issue that does not exist under this tenant is NotFoundError', async () => {
    const { repo, calls } = repoWith([null]);
    await expect(closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'x')).rejects.toThrow(NotFoundError);
    expect(calls).toEqual([]);
  });

  it('a merged issue cannot be closed — the state graph refuses, and that surfaces', async () => {
    const { repo } = repoWith([issue('merged')], async () => {
      throw new InvalidIssueTransitionError('merged -> resolved is not a declared transition');
    });
    await expect(closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'x')).rejects.toThrow(
      InvalidIssueTransitionError,
    );
  });

  it('losing a race to another close is a no-op, not an error — the retry lands on the same resolution', async () => {
    const { repo } = repoWith([issue('investigating'), issue('resolved')], async () => {
      throw new ConcurrentModificationError('Issue');
    });
    const result = await closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'x');
    expect(result).toMatchObject({ closed: false, issue: { state: 'resolved' } });
  });

  it('a transition that finds the issue already resolved by the time it reads is the same no-op', async () => {
    // Two closes both passed the first read; the loser's own read inside `transition` sees
    // `resolved` and the state graph refuses `resolved -> resolved`.
    const { repo } = repoWith([issue('investigating'), issue('resolved')], async () => {
      throw new InvalidIssueTransitionError('resolved -> resolved is not a declared transition');
    });
    const result = await closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'x');
    expect(result).toMatchObject({ closed: false, issue: { state: 'resolved' } });
  });

  it('a conflict that left the state untouched (a busy signal stream) is retried and then closes', async () => {
    let attempts = 0;
    const { repo } = repoWith([issue('investigating')], async () => {
      attempts += 1;
      if (attempts === 1) throw new ConcurrentModificationError('Issue');
      return issue('resolved');
    });
    const result = await closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'x');
    expect(result).toMatchObject({ closed: true, issue: { state: 'resolved' } });
    expect(attempts).toBe(2);
  });

  it('gives up after three attempts rather than looping on a permanently contended issue', async () => {
    let attempts = 0;
    const { repo } = repoWith([issue('investigating')], async () => {
      attempts += 1;
      throw new ConcurrentModificationError('Issue');
    });
    await expect(closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'x')).rejects.toThrow(
      ConcurrentModificationError,
    );
    expect(attempts).toBe(3);
  });

  it('a refusal by the state graph is never retried', async () => {
    let attempts = 0;
    const { repo } = repoWith([issue('merged')], async () => {
      attempts += 1;
      throw new InvalidIssueTransitionError('merged -> resolved is not a declared transition');
    });
    await expect(closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'x')).rejects.toThrow(
      InvalidIssueTransitionError,
    );
    expect(attempts).toBe(1);
  });

  it('losing a race to something that is not a close still surfaces the conflict, without a retry', async () => {
    let attempts = 0;
    const { repo } = repoWith([issue('investigating'), issue('stale')], async () => {
      attempts += 1;
      throw new ConcurrentModificationError('Issue');
    });
    await expect(closeIssue(repo, CONTEXT, 'issue-1', 'pavlo', 'x')).rejects.toThrow(
      ConcurrentModificationError,
    );
    expect(attempts).toBe(1);
  });
});
