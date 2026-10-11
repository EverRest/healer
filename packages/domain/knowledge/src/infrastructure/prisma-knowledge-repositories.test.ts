import { describe, expect, it } from 'vitest';
import {
  PrismaDocumentSectionRepository,
  PrismaDocumentVersionRepository,
  PrismaExpectedBehaviorRepository,
  PrismaKnowledgeConstraintRepository,
  PrismaKnowledgeDocumentRepository,
  PrismaKnowledgeSourceRepository,
} from './prisma-knowledge-repositories.js';
import type { PrismaKnowledgeIngestStore } from './prisma-knowledge-ingest-store.js';

const T = '00000000-0000-4000-8000-000000000001';

// FR-027: a retrieval without a TenantContext does not type-check (checked by `tsc --build`).
function neverCalled(
  s: PrismaKnowledgeSourceRepository,
  d: PrismaKnowledgeDocumentRepository,
  v: PrismaDocumentVersionRepository,
  sec: PrismaDocumentSectionRepository,
  e: PrismaExpectedBehaviorRepository,
  c: PrismaKnowledgeConstraintRepository,
  ingest: PrismaKnowledgeIngestStore,
): void {
  // @ts-expect-error a tenant id string is not a TenantContext
  void s.findById(T, 'x');
  // @ts-expect-error no tenant at all
  void s.list();
  // @ts-expect-error a tenant id string is not a TenantContext
  void d.findByExternalRef(T, 's', 'p');
  // @ts-expect-error a plain object is not a TenantContext
  void v.listForDocument({ tenantId: T }, 'd');
  // @ts-expect-error no tenant at all
  void sec.listForVersion('v');
  // @ts-expect-error a tenant id string is not a TenantContext
  void e.findByStableKey(T, 'k');
  // @ts-expect-error a tenant id string is not a TenantContext
  void c.listByScope(T, 'feature', 'r');
  // @ts-expect-error the ingest store takes a TenantContext first
  void ingest.ingest(T, {});
}

describe('knowledge repositories (compile-time tenant guarantee)', () => {
  it('is proven by tsc, not at run time', () => {
    void neverCalled;
    expect(true).toBe(true);
  });
});
