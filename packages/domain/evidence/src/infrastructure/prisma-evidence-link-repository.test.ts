import { describe, expect, it } from 'vitest';
import { TenantContext, scope } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import { PrismaEvidenceLinkRepository } from './prisma-evidence-link-repository.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000c1');

describe('PrismaEvidenceLinkRepository.write — refuses to run outside any step context (FR-008, R-06)', () => {
  it('throws before ever touching the database when no step is declared', async () => {
    // No real PrismaClient needed: the guard must fire before `this.prisma` is used at all.
    const repo = new PrismaEvidenceLinkRepository(undefined as unknown as PrismaClient);
    await expect(
      repo.write(
        scope(CONTEXT, {
          id: 'l1',
          evidenceId: 'e1',
          conclusionType: 'diagnosis',
          conclusionId: 'c1',
          relation: 'supports',
        }),
      ),
    ).rejects.toThrow(/step/i);
  });
});
