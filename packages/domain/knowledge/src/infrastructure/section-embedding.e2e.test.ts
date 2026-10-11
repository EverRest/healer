import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@healer/prisma-client';
import { TenantContext } from '@healer/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySqlFile,
  query,
  startPostgres,
  type StartedPostgres,
} from '../../../../../test/containers.js';
import {
  EMBEDDING_DIMENSION,
  NEAREST_SQL,
  PrismaSectionEmbeddingRepository,
  TenantPartitionMissingError,
} from './prisma-section-embedding-repository.js';

/**
 * 005 T011/T012 (FR-027, R-05): an ANN query runs inside ONE tenant's partition. A single global
 * HNSW index with `WHERE tenant_id = $1` is the post-filtering FR-027 forbids — the index returns a
 * global top-k and the filter removes what does not belong, so a small tenant gets fewer results
 * than it has, with no error. These tests prove the shape from the query plan, prove the assertion
 * rejects the forbidden shape (negative controls), and prove the recall consequence.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../prisma/migrations/', import.meta.url));
const tenantOf = (n: string) =>
  TenantContext.forTrustedInternalUse(`00000000-0000-4000-8000-0000000005${n}`);
const A = tenantOf('a1');
const B = tenantOf('b2');
const C = tenantOf('c3');
const D = tenantOf('d4'); // never provisioned: has sections but no partition
const E = tenantOf('e5'); // a stray, unattached table carries its partition's name
const SMALL = 20;
const LARGE = 3000;
const partitionOf = (t: TenantContext) => `section_embedding_${t.tenantId.replaceAll('-', '')}`;

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
};
type Plan = { Plan: PlanNode };
const collect = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(collect)];

/**
 * The T012 assertion. Passes only when the plan reads exactly one relation — the tenant's own
 * partition. Nodes that never ran (`Actual Loops: 0`, run-time pruned under a generic plan) do not
 * count as reads. With `hnswIndexes`, the partition must also be read through one of its HNSW indexes.
 */
function assertConfinedToTenantPartition(
  plan: Plan,
  tenant: TenantContext,
  { hnswIndexes }: { hnswIndexes?: string[] } = {},
): void {
  const scans = collect(plan.Plan).filter((n) => n['Relation Name'] && n['Actual Loops'] !== 0);
  const relations = [...new Set(scans.map((n) => n['Relation Name']))];
  const expected = partitionOf(tenant);
  if (relations.length !== 1 || relations[0] !== expected) {
    throw new Error(`scans [${relations.join(', ')}], expected only ${expected}`);
  }
  // A 20-row partition legitimately prefers its primary key plus an exact sort (better recall than
  // HNSW); confinement is what is asserted for it. A partition big enough for the planner to prefer
  // the ANN index must be read through its own HNSW index.
  if (hnswIndexes && !scans.some((n) => hnswIndexes.includes(n['Index Name'] ?? ''))) {
    throw new Error(`does not use an HNSW index of ${expected} (${hnswIndexes.join(', ')})`);
  }
}

const uuid = (off: number, n: number) =>
  `00000000-0000-4000-8000-${String(off).padStart(2, '0')}${String(n).padStart(10, '0')}`;

/** A source, document, version and `n` sections for a tenant — no embeddings. */
const seedSections = (tenant: TenantContext, n: number, off: number) => `
  insert into knowledge.knowledge_source (id, tenant_id, kind, adapter_key, connection_state, sync_state, document_classes, implemented)
    values ('${uuid(off, 1)}', '${tenant.tenantId}', 'repository_markdown', 'gitlab', 'connected', 'idle', '{}', true);
  begin;
  insert into knowledge.knowledge_document (id, tenant_id, source_id, external_ref, title, document_class, provenance, current_version_id, availability)
    values ('${uuid(off, 2)}', '${tenant.tenantId}', '${uuid(off, 1)}', 'a.md', 'a', 'readme', 'human_authored', '${uuid(off, 3)}', 'available');
  insert into knowledge.document_version (id, tenant_id, document_id, version_no, content_hash, captured_at)
    values ('${uuid(off, 3)}', '${tenant.tenantId}', '${uuid(off, 2)}', 1, 'h', now());
  commit;
  insert into knowledge.document_section (id, tenant_id, document_version_id, ordinal, heading_path, content, char_start, char_end)
    select gen_random_uuid(), '${tenant.tenantId}', '${uuid(off, 3)}', i, '{}', 'c' || i, 0, 1 from generate_series(1, ${n}) i;`;

/** Seeded, so the corpus is identical on every run. `hot` is the dimension this tenant clusters on. */
const seedEmbeddings = (tenant: TenantContext, hot: number) => `
  select setseed(0.42);
  insert into knowledge.section_embedding (tenant_id, section_id, embedding, model_ref, built_at)
    select s.tenant_id, s.id,
      ('[' || array_to_string(array(select (random() - 0.5) + case when g = ${hot} then 10 else 0 end
                                    from generate_series(1, ${EMBEDDING_DIMENSION}) g where s.ordinal >= 0), ',') || ']')::vector,
      'test-model', now()
    from knowledge.document_section s where s.tenant_id = '${tenant.tenantId}';`;

/** A query vector sitting on dimension `hot`: nearest to whichever tenant clusters there. */
const queryNear = (hot: number) =>
  Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => (i + 1 === hot ? 1 : 0));

describe('section_embedding is partitioned by tenant (005 T011/T012)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaSectionEmbeddingRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    repo = new PrismaSectionEmbeddingRepository(prisma);
    await repo.ensureTenantPartition(A);
    await repo.ensureTenantPartition(B);
    await query(pg, seedSections(A, SMALL, 11) + seedEmbeddings(A, 2)); // A clusters on dimension 2
    await query(pg, seedSections(B, LARGE, 12) + seedEmbeddings(B, 1)); // B clusters on dimension 1
    await query(pg, seedSections(D, 3, 14));
    await query(pg, 'analyze knowledge.section_embedding');
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  let prepared = 0;
  const hnswIndexesOf = async (t: TenantContext) =>
    (
      await query(
        pg,
        `select indexname from pg_indexes where schemaname = 'knowledge' and tablename = '${partitionOf(t)}'
           and indexdef like '%USING hnsw%'`,
      )
    )
      .split('\n')
      .filter(Boolean);

  /** EXPLAIN the repository's own query, with bound parameters, as the planner would run it. */
  const explain = (tenantId: string | null, vector: number[], sql = NEAREST_SQL) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off'); // tiny tables prefer a seq scan
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': Plan[] }[]>(
        `EXPLAIN (FORMAT JSON) ${sql}`,
        ...(tenantId === null ? [`[${vector}]`, 5] : [`[${vector}]`, tenantId, 5]),
      );
      return rows[0]!['QUERY PLAN'][0]!;
    });

  /** The same query under a forced GENERIC plan, executed, so run-time pruning is what is observed. */
  const explainGeneric = (tenantId: string, vector: number[]) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      await tx.$executeRawUnsafe('SET LOCAL plan_cache_mode = force_generic_plan');
      const name = `ann_generic_${++prepared}`; // prepared statements outlive the transaction
      await tx.$executeRawUnsafe(`PREPARE ${name} AS ${NEAREST_SQL}`);
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': Plan[] }[]>(
        `EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE ${name}('[${vector}]', '${tenantId}', 5)`,
      );
      return rows[0]!['QUERY PLAN'][0]!;
    });

  it('has exactly the columns of an index — no content (SC-004: truncatable and rebuildable)', async () => {
    expect(
      await query(
        pg,
        `select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
         where table_schema = 'knowledge' and table_name = 'section_embedding'`,
      ),
    ).toBe('tenant_id,section_id,embedding,model_ref,built_at');
    expect(
      await query(
        pg,
        `select c.relkind::text || ':' || pg_get_partkeydef(c.oid) from pg_class c
         where c.oid = 'knowledge.section_embedding'::regclass`,
      ),
    ).toBe('p:LIST (tenant_id)');
  });

  it('ensureTenantPartition creates the partition, idempotently and under concurrency', async () => {
    await Promise.all(Array.from({ length: 8 }, () => repo.ensureTenantPartition(C)));
    await repo.ensureTenantPartition(C);
    expect(
      await query(
        pg,
        `select count(*) from pg_inherits where inhparent = 'knowledge.section_embedding'::regclass
           and inhrelid = 'knowledge.${partitionOf(C)}'::regclass`,
      ),
    ).toBe('1');
  });

  it('every partition has a cosine HNSW index: a partition without one is unrepresentable', async () => {
    const parts = await query(
      pg,
      `select count(*) from pg_inherits where inhparent = 'knowledge.section_embedding'::regclass`,
    );
    expect(Number(parts)).toBeGreaterThanOrEqual(3);
    for (const t of [A, B, C]) {
      const defs = await query(
        pg,
        `select indexdef from pg_indexes where schemaname = 'knowledge' and tablename = '${partitionOf(t)}'
           and indexdef like '%USING hnsw%'`,
      );
      expect(defs).toContain('vector_cosine_ops');
    }
    // The index is declared once on the parent, which is what makes every present and future
    // partition carry one.
    expect(
      await query(
        pg,
        `select count(*) from pg_indexes where schemaname = 'knowledge' and tablename = 'section_embedding'
           and indexdef like '%USING hnsw%' and indexdef like '%vector_cosine_ops%'`,
      ),
    ).toBe('1');
  });

  it("confines tenant A's ANN query to A's partition (T012)", async () => {
    assertConfinedToTenantPartition(await explain(A.tenantId, queryNear(1)), A);
    assertConfinedToTenantPartition(await explain(B.tenantId, queryNear(1)), B, {
      hnswIndexes: await hnswIndexesOf(B),
    });
  });

  it('confinement also holds under a forced GENERIC plan (run-time pruning)', async () => {
    const plan = await explainGeneric(A.tenantId, queryNear(1));
    // Guard against passing for the wrong reason: this really is a generic plan (params, not literals).
    expect(JSON.stringify(plan)).toContain('$2');
    assertConfinedToTenantPartition(plan, A);
    assertConfinedToTenantPartition(await explainGeneric(B.tenantId, queryNear(1)), B);
  });

  it('NEGATIVE CONTROL: a global HNSW index plus WHERE tenant_id fails the assertion', async () => {
    await query(
      pg,
      `create table public.global_control (tenant_id uuid, section_id uuid, embedding vector(${EMBEDDING_DIMENSION}));
       insert into public.global_control select tenant_id, section_id, embedding from knowledge.section_embedding;
       create index global_control_hnsw on public.global_control using hnsw (embedding vector_cosine_ops);
       analyze public.global_control;`,
    );
    // The control really holds A's rows and the plan really goes through the global HNSW index.
    expect(
      await query(
        pg,
        `select count(*) from public.global_control where tenant_id = '${A.tenantId}'`,
      ),
    ).toBe(String(SMALL));
    const forbidden = NEAREST_SQL.replace('knowledge.section_embedding', 'public.global_control');
    expect(forbidden).not.toBe(NEAREST_SQL);
    const plan = await explain(A.tenantId, queryNear(1), forbidden);
    expect(collect(plan.Plan).some((n) => n['Index Name'] === 'global_control_hnsw')).toBe(true);
    expect(() => assertConfinedToTenantPartition(plan, A, { hnswIndexes: [] })).toThrow(
      /global_control/,
    );
  });

  it('NEGATIVE CONTROL: the partitioned table without the tenant predicate fails the assertion', async () => {
    const noTenant =
      'SELECT section_id FROM knowledge.section_embedding ORDER BY embedding <=> $1::vector LIMIT $2';
    const plan = await explain(null, queryNear(1), noTenant);
    expect(() => assertConfinedToTenantPartition(plan, A)).toThrow(/scans \[.*,.*\]/);
  });

  it('returns ALL of a small tenant beside a large one — there is no global top-k', async () => {
    // The query sits on the LARGE tenant's cluster, so a global top-k is entirely B's rows.
    const mine = await repo.nearest(A, queryNear(1), SMALL);
    expect(mine).toHaveLength(SMALL);
    expect(new Set(mine.map((r) => r.sectionId)).size).toBe(SMALL);
    const theirs = await repo.nearest(B, queryNear(1), 50);
    expect(theirs).toHaveLength(50);
    // Each tenant's results are that tenant's own sections.
    const owned = (t: TenantContext, rows: { sectionId: string }[]) =>
      query(
        pg,
        `select count(*) from knowledge.document_section where tenant_id = '${t.tenantId}'
           and id in (${rows.map((r) => `'${r.sectionId}'`).join(',')})`,
      );
    expect(await owned(A, mine)).toBe(String(SMALL));
    expect(await owned(B, theirs)).toBe('50');
  });

  it('NEGATIVE CONTROL: the global-index shape loses the small tenant (the bug R-05 names)', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<unknown[]>(
        `SELECT section_id FROM public.global_control WHERE tenant_id = $2::uuid
         ORDER BY embedding <=> $1::vector LIMIT $3`,
        `[${queryNear(1)}]`,
        A.tenantId,
        SMALL,
      );
    });
    expect(rows.length).toBeLessThan(SMALL);
  });

  it('upsert writes into the tenant partition only', async () => {
    const sectionId = await query(
      pg,
      `select id from knowledge.document_section where tenant_id = '${A.tenantId}' limit 1`,
    );
    await repo.upsert(A, { sectionId, embedding: queryNear(2), modelRef: 'm2' });
    expect(
      await query(
        pg,
        `select model_ref from knowledge.${partitionOf(A)} where section_id = '${sectionId}'`,
      ),
    ).toBe('m2');
  });

  it('a tenant without a partition fails loudly: no DEFAULT partition catches its rows', async () => {
    expect(
      await query(
        pg,
        `select partdefid from pg_partitioned_table where partrelid = 'knowledge.section_embedding'::regclass`,
      ),
    ).toBe('0');
    const sectionId = await query(
      pg,
      `select id from knowledge.document_section where tenant_id = '${D.tenantId}' limit 1`,
    );
    expect(sectionId).not.toBe('');
    await expect(
      repo.upsert(D, { sectionId, embedding: queryNear(2), modelRef: 'm' }),
    ).rejects.toThrow(/no partition of relation "section_embedding" found/);
  });

  it('nearest() on an unprovisioned tenant throws, instead of returning an empty list', async () => {
    await expect(repo.nearest(D, queryNear(1), 5)).rejects.toThrow(TenantPartitionMissingError);
  });

  it('a same-named table that is NOT attached is refused, never mistaken for the partition', async () => {
    await query(
      pg,
      `create table knowledge.${partitionOf(E)} (like knowledge.section_embedding including defaults)`,
    );
    await expect(repo.ensureTenantPartition(E)).rejects.toThrow(/exists but is not attached/);
    await expect(repo.nearest(E, queryNear(1), 5)).rejects.toThrow(TenantPartitionMissingError);
  });
});
