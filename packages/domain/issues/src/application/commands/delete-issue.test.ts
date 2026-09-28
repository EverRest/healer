import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import { deleteIssue } from './delete-issue.js';
import {
  InvalidDeletionRequestError,
  type IssueDeletionRepository,
} from '../../domain/deletion.js';

const TENANT_ID = '00000000-0000-0000-8000-0000000000ad';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

describe('deleteIssue (001 T053)', () => {
  it('scopes the call to the calling tenant and returns what the repository returned', async () => {
    const calls: unknown[][] = [];
    const tombstone = {
      id: 't1',
      tenantId: TENANT_ID,
      targetType: 'issue',
      targetId: 'a',
      requestedBy: 'pavlo',
      reason: 'customer request',
      deletedAt: new Date(0),
    } as const;
    const repo: IssueDeletionRepository = {
      deleteIssue: async (...args) => {
        calls.push(args);
        return { outcome: 'deleted', tombstone };
      },
      findTombstone: async () => null,
    };

    const result = await deleteIssue(repo, CONTEXT, {
      id: 'a',
      requestedBy: 'pavlo',
      reason: 'customer request',
    });

    expect(result).toEqual({ outcome: 'deleted', tombstone });
    expect(calls).toEqual([[{ tenantId: TENANT_ID, id: 'a' }, 'pavlo', 'customer request']]);
  });

  it('refuses a malformed request before the repository is reached', async () => {
    let reached = false;
    const repo: IssueDeletionRepository = {
      deleteIssue: async () => {
        reached = true;
        throw new Error('unreachable');
      },
      findTombstone: async () => null,
    };

    await expect(
      deleteIssue(repo, CONTEXT, { id: 'a', requestedBy: '', reason: 'x' }),
    ).rejects.toThrow(InvalidDeletionRequestError);
    expect(reached).toBe(false);
  });
});
