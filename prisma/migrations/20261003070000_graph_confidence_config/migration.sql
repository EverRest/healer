-- 004 T038/T039 (FR-006, FR-008, R-15).
--
-- (1) Replay key for the edge-provenance merge path: an observation (its `graph_fact` evidence
-- id) is recorded at most once per edge, so a job that runs twice cannot double-count
-- `graph_edge.observation_count`. NULLs stay distinct (human rows carry no observation), which is
-- what a plain unique index already does.
-- CreateIndex
CREATE UNIQUE INDEX "edge_provenance_tenant_id_edge_id_observation_ref_key" ON "architecture"."edge_provenance"("tenant_id", "edge_id", "observation_ref");

-- (2) Per-tenant confidence configuration (R-15: constants are per-tenant, with defaults in
-- code). One row per tenant holding only the overridden knobs; `domain/edge-confidence.ts`
-- validates and lays it over the default at write time. A tenant with no row uses the default.
-- CreateTable
CREATE TABLE "architecture"."confidence_config" (
    "tenant_id" UUID NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "confidence_config_pkey" PRIMARY KEY ("tenant_id")
);
