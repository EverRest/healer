import { describe, expect, it } from 'vitest';
import { PrismaSectionEmbeddingRepository } from './prisma-section-embedding-repository.js';

// FR-027: a retrieval built without a TenantContext must not type-check. These `@ts-expect-error`
// lines are checked by `tsc --build` (this file is compiled): if the repository ever accepted a bare
// tenant string, the directive would be unused and the build would fail.
function neverCalled(repo: PrismaSectionEmbeddingRepository): void {
  // @ts-expect-error a tenant id string is not a TenantContext
  void repo.nearest('00000000-0000-4000-8000-000000000001', [], 1);
  // @ts-expect-error no tenant at all
  void repo.nearest([], 1);
  // @ts-expect-error a tenant id string is not a TenantContext
  void repo.ensureTenantPartition('00000000-0000-4000-8000-000000000001');
  // @ts-expect-error a plain object is not a TenantContext
  void repo.upsert({ tenantId: 'x' }, { sectionId: 's', embedding: [], modelRef: 'm' });
}

describe('PrismaSectionEmbeddingRepository (compile-time tenant guarantee)', () => {
  it('rejects the wrong embedding width before touching the database', async () => {
    void neverCalled;
    // No database: the width check throws before any query is built.
    const repo = new PrismaSectionEmbeddingRepository({} as never);
    const { TenantContext } = await import('@healer/shared');
    const tenant = TenantContext.forTrustedInternalUse('00000000-0000-4000-8000-000000000001');
    await expect(repo.nearest(tenant, [1, 2, 3], 5)).rejects.toThrow(/1024/);
  });
});
