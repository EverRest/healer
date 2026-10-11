import type {
  ConstraintScopeKind,
  DocumentVersion,
  ExpectedBehavior,
  ExpectedBehaviorVersion,
  KnowledgeConstraint,
  KnowledgeDocument,
  KnowledgeSource,
  Prisma,
  PrismaClient,
} from '@healer/prisma-client';
import { scope, type TenantContext } from '@healer/shared';
import { untrustedText, type UntrustedText } from '../domain/untrusted-text.js';

/**
 * Tenant-scoped finders for the knowledge tables (005 T013, FR-027). Every method's first parameter
 * is a `TenantContext`; a bare tenant string, a plain object or no tenant at all does not type-check
 * (`prisma-knowledge-repositories.test.ts`). The tenant goes into the `where` clause through
 * `scope()` — the query layer, never a post-filter — so another tenant's row is `null` / `[]`,
 * indistinguishable from "does not exist" (001 SC-004).
 *
 * Writes for ingest live in `PrismaKnowledgeIngestStore`; the embedding table is
 * `PrismaSectionEmbeddingRepository` (raw SQL, Prisma cannot read a `vector`).
 */
type Db = PrismaClient | Prisma.TransactionClient;

export class PrismaKnowledgeSourceRepository {
  constructor(private readonly db: Db) {}

  findById(ctx: TenantContext, id: string): Promise<KnowledgeSource | null> {
    return this.db.knowledgeSource.findFirst({ where: scope(ctx, { id }) });
  }

  list(ctx: TenantContext): Promise<KnowledgeSource[]> {
    return this.db.knowledgeSource.findMany({ where: scope(ctx, {}), orderBy: { id: 'asc' } });
  }
}

export class PrismaKnowledgeDocumentRepository {
  constructor(private readonly db: Db) {}

  findById(ctx: TenantContext, id: string): Promise<KnowledgeDocument | null> {
    return this.db.knowledgeDocument.findFirst({ where: scope(ctx, { id }) });
  }

  findByExternalRef(
    ctx: TenantContext,
    sourceId: string,
    externalRef: string,
  ): Promise<KnowledgeDocument | null> {
    return this.db.knowledgeDocument.findFirst({ where: scope(ctx, { sourceId, externalRef }) });
  }
}

export class PrismaDocumentVersionRepository {
  constructor(private readonly db: Db) {}

  findById(ctx: TenantContext, id: string): Promise<DocumentVersion | null> {
    return this.db.documentVersion.findFirst({ where: scope(ctx, { id }) });
  }

  listForDocument(ctx: TenantContext, documentId: string): Promise<DocumentVersion[]> {
    return this.db.documentVersion.findMany({
      where: scope(ctx, { documentId }),
      orderBy: { versionNo: 'asc' },
    });
  }
}

export interface SectionView {
  readonly id: string;
  readonly ordinal: number;
  readonly headingPath: readonly string[];
  /** Carried as `UntrustedText`: text read back from storage is still data (FR-026). */
  readonly content: UntrustedText;
  readonly charStart: number;
  readonly charEnd: number;
}

export class PrismaDocumentSectionRepository {
  constructor(private readonly db: Db) {}

  async listForVersion(ctx: TenantContext, documentVersionId: string): Promise<SectionView[]> {
    const rows = await this.db.documentSection.findMany({
      where: scope(ctx, { documentVersionId }),
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        ordinal: true,
        headingPath: true,
        content: true,
        charStart: true,
        charEnd: true,
      },
    });
    return rows.map((r) => ({ ...r, content: untrustedText(r.content) }));
  }
}

export class PrismaExpectedBehaviorRepository {
  constructor(private readonly db: Db) {}

  findByStableKey(ctx: TenantContext, stableKey: string): Promise<ExpectedBehavior | null> {
    return this.db.expectedBehavior.findFirst({ where: scope(ctx, { stableKey }) });
  }

  findById(ctx: TenantContext, id: string): Promise<ExpectedBehavior | null> {
    return this.db.expectedBehavior.findFirst({ where: scope(ctx, { id }) });
  }

  listVersions(ctx: TenantContext, expectedBehaviorId: string): Promise<ExpectedBehaviorVersion[]> {
    return this.db.expectedBehaviorVersion.findMany({
      where: scope(ctx, { expectedBehaviorId }),
      orderBy: { versionNo: 'asc' },
    });
  }

  findVersionById(ctx: TenantContext, id: string): Promise<ExpectedBehaviorVersion | null> {
    return this.db.expectedBehaviorVersion.findFirst({ where: scope(ctx, { id }) });
  }
}

export class PrismaKnowledgeConstraintRepository {
  constructor(private readonly db: Db) {}

  /**
   * What is in force for a scope: only constraints defined by their document's CURRENT version.
   * Every ingest writes the full set again (history is append-only), so without this a superseded
   * value would read as a second definition — a spurious CONSTRAINT_CONFLICT (FR-015).
   */
  listByScope(
    ctx: TenantContext,
    scopeKind: ConstraintScopeKind,
    scopeRef: string,
    name?: string,
  ): Promise<KnowledgeConstraint[]> {
    return this.db.knowledgeConstraint.findMany({
      where: scope(ctx, {
        scopeKind,
        scopeRef,
        documentVersion: { currentOf: { some: {} } },
        ...(name === undefined ? {} : { name }),
      }),
      orderBy: { id: 'asc' },
    });
  }

  listForDocumentVersion(
    ctx: TenantContext,
    documentVersionId: string,
  ): Promise<KnowledgeConstraint[]> {
    return this.db.knowledgeConstraint.findMany({
      where: scope(ctx, { documentVersionId }),
      orderBy: { name: 'asc' },
    });
  }
}
