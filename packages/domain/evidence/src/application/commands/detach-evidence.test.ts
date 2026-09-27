import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import { detachEvidence } from './detach-evidence.js';
import type { EvidenceRepository } from '../../domain/repository.js';
import type { Evidence } from '../../domain/types.js';

/**
 * `detachEvidence` (001 T030): a thin scoping wrapper, but risk-weighted (`packages/domain/evidence`,
 * R-11) still needs a test that exercises it at all — proves the id it's given reaches the
 * repository under the calling tenant's scope, not a different one.
 */
const TENANT_ID = '00000000-0000-0000-8000-0000000000aa';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

describe('detachEvidence (001 T030)', () => {
  it('scopes the detach to the calling tenant and returns what the repository detached', async () => {
    let detachedWhere: unknown;
    const repo: EvidenceRepository = {
      findById: () => Promise.reject(new Error('not used in this test')),
      listByIssue: () => Promise.reject(new Error('not used in this test')),
      record: () => Promise.reject(new Error('not used in this test')),
      detach: async (where) => {
        detachedWhere = where;
        return { id: 'evidence-1', refState: 'detached' } as Evidence;
      },
    };

    const result = await detachEvidence(repo, CONTEXT, 'evidence-1');

    expect(detachedWhere).toMatchObject({ id: 'evidence-1', tenantId: TENANT_ID });
    expect(result).toMatchObject({ id: 'evidence-1', refState: 'detached' });
  });
});
