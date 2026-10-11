import type { Prisma, PrismaClient } from '@healer/prisma-client';
import type { TenantContext } from '@healer/shared';

/** Fixed in the column (research R-15): a `vector(N)` column has one width. */
export const EMBEDDING_DIMENSION = 1024;

/**
 * The ANN query. `tenant_id = $2` is what lets the planner prune to the tenant's partition and use
 * its HNSW index (FR-027, R-05). Exported so the plan test explains the exact text that runs.
 */
export const NEAREST_SQL = `SELECT section_id AS "sectionId", embedding <=> $1::vector AS distance
  FROM knowledge.section_embedding WHERE tenant_id = $2::uuid
  ORDER BY embedding <=> $1::vector LIMIT $3`;

export interface NearestSection {
  readonly sectionId: string;
  readonly distance: number;
}

/**
 * The tenant has no partition attached to `section_embedding`. Without this an ANN query on a
 * partitioned table returns an empty list for an unprovisioned tenant — indistinguishable from "no
 * similar sections".
 */
export class TenantPartitionMissingError extends Error {
  constructor() {
    super('no section_embedding partition is attached for this tenant; provision it first');
    this.name = 'TenantPartitionMissingError';
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(`embedding must have ${EMBEDDING_DIMENSION} dimensions, got ${vector.length}`);
  }
  return `[${vector.join(',')}]`;
}

/**
 * Prisma cannot query a `vector` column, so this is `$queryRaw` throughout. The tenant comes from a
 * `TenantContext` — a repository method accepts nothing else, so a bare tenant string does not
 * type-check. A `TenantContext` is built from verified claims (`fromAuthenticatedClaims`); the one
 * other constructor, `forTrustedInternalUse`, is named so that its appearance in production code is
 * conspicuous. The tenant is always a bound parameter — never interpolated, never optional, never
 * post-filtered.
 */
export class PrismaSectionEmbeddingRepository {
  constructor(private readonly db: Db) {}

  /**
   * Creates the tenant's partition (its HNSW index comes from the index on the parent). Idempotent
   * and safe under concurrent callers (the SQL function serialises on a per-tenant advisory lock).
   * Run it when a tenant is provisioned: creating a partition briefly takes a strong lock on the
   * parent table.
   */
  async ensureTenantPartition(tenant: TenantContext): Promise<void> {
    await this.db
      .$queryRaw`SELECT knowledge.ensure_section_embedding_partition(${tenant.tenantId}::uuid)`;
  }

  /** Writes land in the tenant's partition; a tenant without one fails loudly (no partition found). */
  async upsert(
    tenant: TenantContext,
    row: {
      readonly sectionId: string;
      readonly embedding: readonly number[];
      readonly modelRef: string;
    },
  ): Promise<void> {
    await this.db.$executeRaw`
      INSERT INTO knowledge.section_embedding (tenant_id, section_id, embedding, model_ref, built_at)
      VALUES (${tenant.tenantId}::uuid, ${row.sectionId}::uuid, ${toVectorLiteral(row.embedding)}::vector,
              ${row.modelRef}, now())
      ON CONFLICT (tenant_id, section_id)
      DO UPDATE SET embedding = EXCLUDED.embedding, model_ref = EXCLUDED.model_ref, built_at = EXCLUDED.built_at`;
  }

  /** @throws TenantPartitionMissingError when the tenant has no partition (never an empty list). */
  async nearest(
    tenant: TenantContext,
    embedding: readonly number[],
    limit: number,
  ): Promise<NearestSection[]> {
    const literal = toVectorLiteral(embedding);
    const attached = await this.db.$queryRaw<{ part: string | null }[]>`
      SELECT knowledge.section_embedding_partition_of(${tenant.tenantId}::uuid) AS part`;
    if (attached[0]?.part == null) throw new TenantPartitionMissingError();
    return this.db.$queryRawUnsafe<NearestSection[]>(NEAREST_SQL, literal, tenant.tenantId, limit);
  }
}
