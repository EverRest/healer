-- DropCheckConstraint
ALTER TABLE "architecture"."graph_node" DROP CONSTRAINT "graph_node_product_confirmed_human_check";

-- DropIndex
DROP INDEX "architecture"."graph_node_tenant_id_lifecycle_state_idx";

-- DropForeignKey
ALTER TABLE "architecture"."draft_item" DROP CONSTRAINT "draft_item_draft_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."discovery_draft" DROP CONSTRAINT "discovery_draft_run_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."discovery_source_outcome" DROP CONSTRAINT "discovery_source_outcome_run_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."flow_attr" DROP CONSTRAINT "flow_attr_node_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."feature_attr" DROP CONSTRAINT "feature_attr_node_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."endpoint_attr" DROP CONSTRAINT "endpoint_attr_node_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."repository_attr" DROP CONSTRAINT "repository_attr_node_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."deployment_unit_attr" DROP CONSTRAINT "deployment_unit_attr_node_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."component_attr" DROP CONSTRAINT "component_attr_node_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."edge_provenance" DROP CONSTRAINT "edge_provenance_edge_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."graph_edge" DROP CONSTRAINT "graph_edge_to_node_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "architecture"."graph_edge" DROP CONSTRAINT "graph_edge_from_node_id_tenant_id_fkey";

-- DropIndex
DROP INDEX "architecture"."drift_finding_tenant_id_issue_id_idx";

-- DropIndex
DROP INDEX "architecture"."drift_finding_tenant_id_state_idx";

-- DropIndex
DROP INDEX "architecture"."draft_item_tenant_id_proposal_digest_idx";

-- DropIndex
DROP INDEX "architecture"."draft_item_tenant_id_draft_id_state_idx";

-- DropIndex
DROP INDEX "architecture"."discovery_draft_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."discovery_draft_tenant_id_run_id_idx";

-- DropIndex
DROP INDEX "architecture"."discovery_source_outcome_tenant_id_run_id_idx";

-- DropIndex
DROP INDEX "architecture"."discovery_run_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."discovery_run_tenant_id_started_at_idx";

-- DropIndex
DROP INDEX "architecture"."flow_attr_tenant_id_idx";

-- DropIndex
DROP INDEX "architecture"."flow_attr_node_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."feature_attr_tenant_id_idx";

-- DropIndex
DROP INDEX "architecture"."feature_attr_node_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."endpoint_attr_tenant_id_idx";

-- DropIndex
DROP INDEX "architecture"."endpoint_attr_node_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."repository_attr_tenant_id_idx";

-- DropIndex
DROP INDEX "architecture"."repository_attr_node_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."deployment_unit_attr_tenant_id_idx";

-- DropIndex
DROP INDEX "architecture"."deployment_unit_attr_node_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."component_attr_tenant_id_idx";

-- DropIndex
DROP INDEX "architecture"."component_attr_node_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."edge_provenance_tenant_id_edge_id_idx";

-- DropIndex
DROP INDEX "architecture"."graph_edge_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."graph_edge_tenant_id_to_node_id_idx";

-- DropIndex
DROP INDEX "architecture"."graph_edge_tenant_id_from_node_id_idx";

-- DropIndex
DROP INDEX "architecture"."graph_node_id_tenant_id_key";

-- DropIndex
DROP INDEX "architecture"."graph_node_tenant_id_natural_key_idx";

-- DropTable
DROP TABLE "architecture"."drift_finding";

-- DropTable
DROP TABLE "architecture"."proposal_rejection";

-- DropTable
DROP TABLE "architecture"."draft_item";

-- DropTable
DROP TABLE "architecture"."discovery_draft";

-- DropTable
DROP TABLE "architecture"."discovery_source_outcome";

-- DropTable
DROP TABLE "architecture"."discovery_run";

-- DropTable
DROP TABLE "architecture"."flow_attr";

-- DropTable
DROP TABLE "architecture"."feature_attr";

-- DropTable
DROP TABLE "architecture"."endpoint_attr";

-- DropTable
DROP TABLE "architecture"."repository_attr";

-- DropTable
DROP TABLE "architecture"."deployment_unit_attr";

-- DropTable
DROP TABLE "architecture"."component_attr";

-- DropTable
DROP TABLE "architecture"."edge_provenance";

-- DropTable
DROP TABLE "architecture"."graph_edge";

-- DropTable
DROP TABLE "architecture"."graph_node";

-- DropEnum
DROP TYPE "architecture"."drift_finding_state";

-- DropEnum
DROP TYPE "architecture"."drift_finding_kind";

-- DropEnum
DROP TYPE "architecture"."draft_item_state";

-- DropEnum
DROP TYPE "architecture"."draft_item_op";

-- DropEnum
DROP TYPE "architecture"."discovery_draft_state";

-- DropEnum
DROP TYPE "architecture"."discovery_source_reason_code";

-- DropEnum
DROP TYPE "architecture"."discovery_source_status";

-- DropEnum
DROP TYPE "architecture"."discovery_outcome";

-- DropEnum
DROP TYPE "architecture"."discovery_trigger";

-- DropEnum
DROP TYPE "architecture"."endpoint_protocol";

-- DropEnum
DROP TYPE "architecture"."repository_vcs";

-- DropEnum
DROP TYPE "architecture"."deployment_runtime_kind";

-- DropEnum
DROP TYPE "architecture"."component_type";

-- DropEnum
DROP TYPE "architecture"."graph_edge_type";

-- DropEnum
DROP TYPE "architecture"."node_lifecycle_state";

-- DropEnum
DROP TYPE "architecture"."graph_element_state";

-- DropEnum
DROP TYPE "architecture"."provenance_class";

-- DropEnum
DROP TYPE "architecture"."graph_layer";

-- DropEnum
DROP TYPE "architecture"."graph_node_kind";

-- DropSchema
-- Review fix (post-004 T002): this was missing — every other schema this migration set
-- introduces (e.g. 20260927030000_outbox's "events") drops its own schema in down.sql, but T002
-- never did for "architecture". A dropped-every-table-but-not-the-schema down.sql would still
-- have passed prisma/migration.e2e.test.ts's old "leaving no table behind" check unnoticed — that
-- assertion counts tables, and an empty undropped schema has none — so that test was extended
-- with a direct pg_namespace check for "architecture" alongside this fix.
DROP SCHEMA IF EXISTS "architecture";
