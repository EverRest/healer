-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "architecture";

-- CreateEnum
CREATE TYPE "architecture"."graph_node_kind" AS ENUM ('component', 'deployment_unit', 'repository', 'endpoint', 'feature', 'flow', 'external');

-- CreateEnum
CREATE TYPE "architecture"."graph_layer" AS ENUM ('code', 'runtime', 'product');

-- CreateEnum
CREATE TYPE "architecture"."provenance_class" AS ENUM ('human_authored', 'human_confirmed', 'derived_from_trace', 'derived_from_runtime', 'derived_from_code', 'derived_from_config', 'inferred_from_convention');

-- CreateEnum
CREATE TYPE "architecture"."graph_element_state" AS ENUM ('proposed', 'confirmed', 'rejected', 'stale');

-- CreateEnum
CREATE TYPE "architecture"."node_lifecycle_state" AS ENUM ('active', 'unobserved', 'unresolved', 'possibly_removed');

-- CreateEnum
CREATE TYPE "architecture"."graph_edge_type" AS ENUM ('depends_on', 'calls', 'deploys', 'contains', 'implements', 'exposes', 'serves_feature', 'built_from');

-- CreateEnum
CREATE TYPE "architecture"."component_type" AS ENUM ('service', 'library', 'frontend', 'worker', 'job', 'datastore', 'external');

-- CreateEnum
CREATE TYPE "architecture"."deployment_runtime_kind" AS ENUM ('container', 'function', 'vm', 'static_site', 'managed_service');

-- CreateEnum
CREATE TYPE "architecture"."repository_vcs" AS ENUM ('gitlab');

-- CreateEnum
CREATE TYPE "architecture"."endpoint_protocol" AS ENUM ('http', 'grpc', 'event', 'cli');

-- CreateEnum
CREATE TYPE "architecture"."discovery_trigger" AS ENUM ('onboarding', 'scheduled', 'manual', 'post_deploy');

-- CreateEnum
CREATE TYPE "architecture"."discovery_outcome" AS ENUM ('complete', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "architecture"."discovery_source_status" AS ENUM ('collected', 'partial', 'unavailable', 'timed_out', 'withheld', 'not_attempted');

-- CreateEnum
CREATE TYPE "architecture"."discovery_source_reason_code" AS ENUM ('source_unreachable', 'auth_revoked', 'timeout', 'retention_exceeded', 'capability_unavailable', 'budget_exhausted', 'redaction_withheld', 'schema_rejected', 'empty_result');

-- CreateEnum
CREATE TYPE "architecture"."discovery_draft_state" AS ENUM ('open', 'applied', 'abandoned');

-- CreateEnum
CREATE TYPE "architecture"."draft_item_op" AS ENUM ('add_node', 'add_edge', 'modify_attributes', 'mark_removed');

-- CreateEnum
CREATE TYPE "architecture"."draft_item_state" AS ENUM ('proposed', 'confirmed', 'rejected', 'superseded');

-- CreateEnum
CREATE TYPE "architecture"."drift_finding_kind" AS ENUM ('observed_edge_absent', 'recorded_edge_contradicted', 'deployment_unit_missing', 'product_link_dangling');

-- CreateEnum
CREATE TYPE "architecture"."drift_finding_state" AS ENUM ('open', 'resolved_graph_updated', 'resolved_observation_rejected', 'dismissed');

-- CreateTable
CREATE TABLE "architecture"."graph_node" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "node_kind" "architecture"."graph_node_kind" NOT NULL,
    "layer" "architecture"."graph_layer",
    "name" TEXT NOT NULL,
    "natural_key" TEXT NOT NULL,
    "provenance" "architecture"."provenance_class",
    "strength" SMALLINT,
    "confidence" SMALLINT,
    "state" "architecture"."graph_element_state" NOT NULL,
    "lifecycle_state" "architecture"."node_lifecycle_state" NOT NULL DEFAULT 'active',
    "observation_ref" UUID,
    "actor_ref" TEXT,
    "discovery_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graph_node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "architecture"."graph_edge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_node_id" UUID NOT NULL,
    "to_node_id" UUID NOT NULL,
    "edge_type" "architecture"."graph_edge_type" NOT NULL,
    "layer" "architecture"."graph_layer",
    "provenance" "architecture"."provenance_class",
    "strength" SMALLINT,
    "confidence" SMALLINT,
    "state" "architecture"."graph_element_state" NOT NULL,
    "observation_count" BIGINT NOT NULL DEFAULT 0,
    "last_observed_at" TIMESTAMPTZ(6),

    CONSTRAINT "graph_edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "architecture"."edge_provenance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "edge_id" UUID NOT NULL,
    "provenance" "architecture"."provenance_class" NOT NULL,
    "strength" SMALLINT NOT NULL,
    "confidence" SMALLINT NOT NULL,
    "observation_ref" UUID,
    "adapter_key" TEXT NOT NULL,
    "adapter_version" TEXT NOT NULL,
    "discovery_run_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_provenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "architecture"."component_attr" (
    "node_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "component_type" "architecture"."component_type" NOT NULL,
    "characteristics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "owner_ref" TEXT,

    CONSTRAINT "component_attr_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "architecture"."deployment_unit_attr" (
    "node_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "environment" TEXT NOT NULL,
    "runtime_kind" "architecture"."deployment_runtime_kind" NOT NULL,
    "runtime_ref" TEXT NOT NULL,
    "current_version" TEXT,
    "last_deployed_at" TIMESTAMPTZ(6),

    CONSTRAINT "deployment_unit_attr_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "architecture"."repository_attr" (
    "node_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vcs" "architecture"."repository_vcs" NOT NULL,
    "project_ref" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL,

    CONSTRAINT "repository_attr_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "architecture"."endpoint_attr" (
    "node_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "protocol" "architecture"."endpoint_protocol" NOT NULL,
    "method" TEXT,
    "path_template" TEXT,
    "contract_ref" TEXT,

    CONSTRAINT "endpoint_attr_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "architecture"."feature_attr" (
    "node_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "description" TEXT,
    "product_owner_ref" TEXT,

    CONSTRAINT "feature_attr_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "architecture"."flow_attr" (
    "node_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entry_component_id" UUID,
    "ordered_step_refs" JSONB NOT NULL,
    "owner" TEXT,
    "source_document_ref" TEXT,

    CONSTRAINT "flow_attr_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "architecture"."discovery_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "base_version" INTEGER NOT NULL,
    "trigger" "architecture"."discovery_trigger" NOT NULL,
    "runner_id" TEXT NOT NULL,
    "adapter_versions" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" "architecture"."discovery_outcome",
    "nodes_proposed" INTEGER NOT NULL DEFAULT 0,
    "edges_proposed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "discovery_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "architecture"."discovery_source_outcome" (
    "run_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "status" "architecture"."discovery_source_status" NOT NULL,
    "reason_code" "architecture"."discovery_source_reason_code",
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,

    CONSTRAINT "discovery_source_outcome_pkey" PRIMARY KEY ("run_id","source_key")
);

-- CreateTable
CREATE TABLE "architecture"."discovery_draft" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "base_version" INTEGER NOT NULL,
    "state" "architecture"."discovery_draft_state" NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "review_seconds" INTEGER,
    "proposals_count" INTEGER,
    "accepted_unchanged_count" INTEGER,

    CONSTRAINT "discovery_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "architecture"."draft_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "op" "architecture"."draft_item_op" NOT NULL,
    "target_node_id" UUID,
    "target_edge_id" UUID,
    "proposed" JSONB NOT NULL,
    "current" JSONB,
    "proposal_digest" TEXT NOT NULL,
    "provenance" "architecture"."provenance_class" NOT NULL,
    "strength" SMALLINT NOT NULL,
    "confidence" SMALLINT NOT NULL,
    "observation_ref" UUID,
    "state" "architecture"."draft_item_state" NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "draft_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "architecture"."proposal_rejection" (
    "tenant_id" UUID NOT NULL,
    "proposal_digest" TEXT NOT NULL,
    "rejected_by" TEXT NOT NULL,
    "rejected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "proposal_rejection_pkey" PRIMARY KEY ("tenant_id","proposal_digest")
);

-- CreateTable
CREATE TABLE "architecture"."drift_finding" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "architecture"."drift_finding_kind" NOT NULL,
    "recorded_side" JSONB NOT NULL,
    "observed_side" JSONB NOT NULL,
    "evidence_ids" UUID[],
    "issue_id" UUID NOT NULL,
    "graph_version" INTEGER NOT NULL,
    "state" "architecture"."drift_finding_state" NOT NULL DEFAULT 'open',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_version" INTEGER,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drift_finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "graph_node_tenant_id_natural_key_idx" ON "architecture"."graph_node"("tenant_id", "natural_key");

-- CreateIndex
CREATE UNIQUE INDEX "graph_node_id_tenant_id_key" ON "architecture"."graph_node"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "graph_edge_tenant_id_from_node_id_idx" ON "architecture"."graph_edge"("tenant_id", "from_node_id");

-- CreateIndex
CREATE INDEX "graph_edge_tenant_id_to_node_id_idx" ON "architecture"."graph_edge"("tenant_id", "to_node_id");

-- CreateIndex
CREATE UNIQUE INDEX "graph_edge_id_tenant_id_key" ON "architecture"."graph_edge"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "edge_provenance_tenant_id_edge_id_idx" ON "architecture"."edge_provenance"("tenant_id", "edge_id");

-- CreateIndex
CREATE INDEX "component_attr_tenant_id_idx" ON "architecture"."component_attr"("tenant_id");

-- CreateIndex
CREATE INDEX "deployment_unit_attr_tenant_id_idx" ON "architecture"."deployment_unit_attr"("tenant_id");

-- CreateIndex
CREATE INDEX "repository_attr_tenant_id_idx" ON "architecture"."repository_attr"("tenant_id");

-- CreateIndex
CREATE INDEX "endpoint_attr_tenant_id_idx" ON "architecture"."endpoint_attr"("tenant_id");

-- CreateIndex
CREATE INDEX "feature_attr_tenant_id_idx" ON "architecture"."feature_attr"("tenant_id");

-- CreateIndex
CREATE INDEX "flow_attr_tenant_id_idx" ON "architecture"."flow_attr"("tenant_id");

-- CreateIndex
CREATE INDEX "discovery_run_tenant_id_started_at_idx" ON "architecture"."discovery_run"("tenant_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_run_id_tenant_id_key" ON "architecture"."discovery_run"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "discovery_source_outcome_tenant_id_run_id_idx" ON "architecture"."discovery_source_outcome"("tenant_id", "run_id");

-- CreateIndex
CREATE INDEX "discovery_draft_tenant_id_run_id_idx" ON "architecture"."discovery_draft"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_draft_id_tenant_id_key" ON "architecture"."discovery_draft"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "draft_item_tenant_id_draft_id_state_idx" ON "architecture"."draft_item"("tenant_id", "draft_id", "state");

-- CreateIndex
CREATE INDEX "draft_item_tenant_id_proposal_digest_idx" ON "architecture"."draft_item"("tenant_id", "proposal_digest");

-- CreateIndex
CREATE INDEX "drift_finding_tenant_id_state_idx" ON "architecture"."drift_finding"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "drift_finding_tenant_id_issue_id_idx" ON "architecture"."drift_finding"("tenant_id", "issue_id");

-- AddForeignKey
ALTER TABLE "architecture"."graph_edge" ADD CONSTRAINT "graph_edge_from_node_id_tenant_id_fkey" FOREIGN KEY ("from_node_id", "tenant_id") REFERENCES "architecture"."graph_node"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."graph_edge" ADD CONSTRAINT "graph_edge_to_node_id_tenant_id_fkey" FOREIGN KEY ("to_node_id", "tenant_id") REFERENCES "architecture"."graph_node"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."edge_provenance" ADD CONSTRAINT "edge_provenance_edge_id_tenant_id_fkey" FOREIGN KEY ("edge_id", "tenant_id") REFERENCES "architecture"."graph_edge"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."component_attr" ADD CONSTRAINT "component_attr_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "architecture"."graph_node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."deployment_unit_attr" ADD CONSTRAINT "deployment_unit_attr_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "architecture"."graph_node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."repository_attr" ADD CONSTRAINT "repository_attr_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "architecture"."graph_node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."endpoint_attr" ADD CONSTRAINT "endpoint_attr_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "architecture"."graph_node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."feature_attr" ADD CONSTRAINT "feature_attr_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "architecture"."graph_node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."flow_attr" ADD CONSTRAINT "flow_attr_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "architecture"."graph_node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."discovery_source_outcome" ADD CONSTRAINT "discovery_source_outcome_run_id_tenant_id_fkey" FOREIGN KEY ("run_id", "tenant_id") REFERENCES "architecture"."discovery_run"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."discovery_draft" ADD CONSTRAINT "discovery_draft_run_id_tenant_id_fkey" FOREIGN KEY ("run_id", "tenant_id") REFERENCES "architecture"."discovery_run"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture"."draft_item" ADD CONSTRAINT "draft_item_draft_id_tenant_id_fkey" FOREIGN KEY ("draft_id", "tenant_id") REFERENCES "architecture"."discovery_draft"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
-- Partial on purpose (data-model.md graph_node "Indexes"): only a non-`active` node is ever
-- looked up by lifecycle state (staleness/removal surfacing, FR-019). Prisma cannot express a
-- partial index, so it lives here only, same pattern as issue.issue's fingerprint index.
CREATE INDEX "graph_node_tenant_id_lifecycle_state_idx" ON "architecture"."graph_node"("tenant_id", "lifecycle_state")
  WHERE "lifecycle_state" <> 'active';

-- CheckConstraint
-- FR-013/SC-002, data-model.md feature_attr: a product-layer node can only be `confirmed`
-- through a human provenance class. No later task claims this CHECK, so T002 adds it directly
-- (unlike graph_node's other two CHECKs, which are T006's). Written as a boolean expression
-- (`NOT a OR b`), same convention as the two T006 CHECKs, because Postgres has no `IMPLIES`.
ALTER TABLE "architecture"."graph_node" ADD CONSTRAINT "graph_node_product_confirmed_human_check"
  CHECK (layer <> 'product' OR state <> 'confirmed' OR provenance IN ('human_authored', 'human_confirmed'));
