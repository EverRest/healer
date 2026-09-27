import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import { attachLink } from './attach-link.js';
import type { EvidenceLinkRepository, NewEvidenceLink } from '../../domain/link-repository.js';
import type { EvidenceLink } from '../../domain/types.js';

/**
 * `attachLink` (001 T028): a thin scoping wrapper, but risk-weighted (`packages/domain/evidence`,
 * R-11) still needs a test that exercises it at all — a repository call with the tenant scope
 * actually applied, not just the type-level proof `link-repository.test.ts` already covers.
 */
const TENANT_ID = '00000000-0000-0000-8000-0000000000aa';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

const LINK: NewEvidenceLink = {
  id: 'link-1',
  evidenceId: 'evidence-1',
  conclusionType: 'diagnosis',
  conclusionId: 'conclusion-1',
  relation: 'supports',
};

describe('attachLink (001 T028)', () => {
  it('scopes the write to the calling tenant and returns what the repository wrote', async () => {
    let written: unknown;
    const repo: EvidenceLinkRepository = {
      write: async (link) => {
        written = link;
        return { ...link, assertedByStep: 'diagnose', assertedAt: new Date() } as EvidenceLink;
      },
      hasLinks: () => Promise.reject(new Error('not used in this test')),
    };

    const result = await attachLink(repo, CONTEXT, LINK);

    expect(written).toMatchObject({ ...LINK, tenantId: TENANT_ID });
    expect(result).toMatchObject(LINK);
  });
});
