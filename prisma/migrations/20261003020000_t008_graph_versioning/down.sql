-- DropIndex
DROP INDEX "architecture"."graph_node_tenant_id_node_kind_valid_from_version_valid_to__idx";

-- DropIndex
DROP INDEX "architecture"."graph_edge_tenant_id_to_node_id_valid_from_version_valid_to_idx";

-- DropIndex
DROP INDEX "architecture"."graph_edge_tenant_id_from_node_id_valid_from_version_valid__idx";

-- DropIndex
DROP INDEX "architecture"."graph_version_tenant_id_version_key";

-- DropTable
DROP TABLE "architecture"."graph_version";

-- AlterTable
ALTER TABLE "architecture"."graph_node" DROP COLUMN "valid_from_version",
DROP COLUMN "valid_to_version";

-- AlterTable
ALTER TABLE "architecture"."graph_edge" DROP COLUMN "valid_from_version",
DROP COLUMN "valid_to_version";

-- DropEnum
DROP TYPE "architecture"."graph_version_minted_by";

-- CreateIndex
-- Restores T002's interim plain tenant-leading indexes on graph_edge, which this migration
-- dropped in favour of the version-aware composites.
CREATE INDEX "graph_edge_tenant_id_from_node_id_idx" ON "architecture"."graph_edge"("tenant_id", "from_node_id");

-- CreateIndex
CREATE INDEX "graph_edge_tenant_id_to_node_id_idx" ON "architecture"."graph_edge"("tenant_id", "to_node_id");
