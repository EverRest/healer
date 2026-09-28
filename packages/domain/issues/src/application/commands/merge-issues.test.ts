import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import { mergeIssues, unmergeIssue } from './merge-issues.js';
import type { Issue } from '../../domain/issue.js';
import type { IssueMergeRepository } from '../../domain/merge-repository.js';

/**
 * `mergeIssues` / `unmergeIssue` (001 T049/T050): thin scoping wrappers, but risk-weighted
 * (`packages/domain/issues`) — this proves the ids, the actor and the reason reach the repository
 * under the calling tenant's scope and nowhere else.
 */
const TENANT_ID = '00000000-0000-0000-8000-0000000000ac';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

describe('mergeIssues / unmergeIssue (001 T049/T050)', () => {
  it('scope both calls to the calling tenant and return what the repository returned', async () => {
    const calls: unknown[][] = [];
    const repo: IssueMergeRepository = {
      merge: async (...args) => {
        calls.push(['merge', ...args]);
        return { outcome: 'already_merged', issue: { id: 'a', state: 'merged' } as Issue };
      },
      unmerge: async (...args) => {
        calls.push(['unmerge', ...args]);
        return { outcome: 'not_merged', issue: { id: 'a', state: 'investigating' } as Issue };
      },
    };

    const merged = await mergeIssues(repo, CONTEXT, {
      id: 'a',
      intoId: 'b',
      actorRef: 'pavlo',
      reason: 'same NPE',
    });
    const unmerged = await unmergeIssue(repo, CONTEXT, { id: 'a', actorRef: 'pavlo' });

    // The outcome reaches the caller as the repository reported it.
    expect(merged).toMatchObject({ outcome: 'already_merged', issue: { state: 'merged' } });
    expect(unmerged).toMatchObject({ outcome: 'not_merged', issue: { state: 'investigating' } });
    expect(calls).toEqual([
      ['merge', { tenantId: TENANT_ID, id: 'a', intoId: 'b' }, 'pavlo', 'same NPE'],
      ['unmerge', { tenantId: TENANT_ID, id: 'a' }, 'pavlo'],
    ]);
  });
});
