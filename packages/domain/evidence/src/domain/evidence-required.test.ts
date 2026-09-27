import { describe, expect, it } from 'vitest';
import { TenantContext, scope } from '@healer/shared';
import { assertHasEvidence, EvidenceRequiredError } from './evidence-required.js';
import type { EvidenceLinkRepository } from './link-repository.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000e1');

function fakeRepository(hasLinks: boolean): EvidenceLinkRepository {
  return {
    write: () => {
      throw new Error('not used in this test');
    },
    hasLinks: async () => hasLinks,
  };
}

describe('assertHasEvidence (FR-009, quickstart 9)', () => {
  it('resolves when the repository reports at least one link', async () => {
    await expect(
      assertHasEvidence(
        fakeRepository(true),
        scope(CONTEXT, { conclusionType: 'diagnosis', conclusionId: 'c1' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('throws EvidenceRequiredError naming the conclusion when there are no links', async () => {
    const promise = assertHasEvidence(
      fakeRepository(false),
      scope(CONTEXT, { conclusionType: 'diagnosis', conclusionId: 'c1' }),
    );
    await expect(promise).rejects.toBeInstanceOf(EvidenceRequiredError);
    await expect(promise).rejects.toThrow('EVIDENCE_REQUIRED: diagnosis c1 has no evidence_link');
  });
});
