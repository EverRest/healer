-- CreateTable
-- Declaratively LIST-partitioned on tenant_id (005 R-05, FR-027): an ANN query runs inside one
-- tenant's partition and its own HNSW index, so there is no global top-k to post-filter. Holds no
-- content — it can be truncated and rebuilt from document_section (SC-004). The partition key is
-- in the primary key, as Postgres requires. `vector(1024)`: one width, fixed (R-15).
CREATE TABLE "knowledge"."section_embedding" (
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "model_ref" TEXT NOT NULL,
    "built_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "section_embedding_pkey" PRIMARY KEY ("tenant_id","section_id")
) PARTITION BY LIST ("tenant_id");

-- AddForeignKey
ALTER TABLE "knowledge"."section_embedding" ADD CONSTRAINT "section_embedding_section_id_tenant_id_fkey" FOREIGN KEY ("section_id", "tenant_id") REFERENCES "knowledge"."document_section"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
-- Declared ONCE, on the partitioned parent: Postgres creates the matching HNSW index on every
-- existing partition and on every partition created later, so "a tenant partition without an HNSW
-- index" is not a state a caller can reach (nothing per-tenant to forget). An ANN query then runs
-- inside one tenant's partition through that partition's own index.
CREATE INDEX "section_embedding_embedding_hnsw_idx" ON "knowledge"."section_embedding" USING hnsw ("embedding" vector_cosine_ops);

-- CreateFunction
-- The partition attached for a tenant, by its partition BOUND (not by name), or NULL. The reader of
-- "does this tenant have a partition": the repository refuses to run an ANN query without one,
-- because on a partitioned table an unprovisioned tenant would otherwise silently get zero rows.
CREATE FUNCTION "knowledge"."section_embedding_partition_of"(p_tenant uuid) RETURNS text AS $$
  SELECT c.relname::text FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = 'knowledge.section_embedding'::regclass
    AND pg_get_expr(c.relpartbound, c.oid) = format('FOR VALUES IN (%L)', p_tenant)
$$ LANGUAGE sql STABLE;

-- CreateFunction
-- The DDL path for a new tenant's partition. Returns the partition name. Idempotent and safe for
-- concurrent callers: two sessions racing on CREATE TABLE can still collide on the catalogue, so the
-- tenant's DDL is serialised by a transaction-scoped advisory lock keyed on the tenant (released at
-- commit/rollback). A table that already carries the partition's name but is NOT attached for this
-- tenant is an error, not success — `IF NOT EXISTS` would have reported a stray table as the
-- partition. Name = section_embedding_<tenant uuid without dashes> (50 chars). `p_tenant` is typed
-- uuid and the names go through %I / %L, so no caller text reaches the DDL. The HNSW index comes from
-- the parent's index above.
CREATE FUNCTION "knowledge"."ensure_section_embedding_partition"(p_tenant uuid) RETURNS text AS $$
DECLARE
  part text := 'section_embedding_' || replace(p_tenant::text, '-', '');
  attached text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge.section_embedding:' || p_tenant::text, 0));
  attached := knowledge.section_embedding_partition_of(p_tenant);
  IF attached IS NOT NULL THEN
    RETURN attached;
  END IF;
  IF to_regclass(format('knowledge.%I', part)) IS NOT NULL THEN
    RAISE EXCEPTION 'knowledge.% exists but is not attached as the section_embedding partition for tenant %', part, p_tenant;
  END IF;
  EXECUTE format(
    'CREATE TABLE knowledge.%I PARTITION OF knowledge.section_embedding FOR VALUES IN (%L)',
    part, p_tenant);
  RETURN part;
END;
$$ LANGUAGE plpgsql;
