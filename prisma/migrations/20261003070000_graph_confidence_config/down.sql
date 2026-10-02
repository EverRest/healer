-- DropTable
DROP TABLE "architecture"."confidence_config";

-- DropIndex
DROP INDEX "architecture"."edge_provenance_tenant_id_edge_id_observation_ref_key";

-- AlterTable
ALTER TABLE "architecture"."edge_provenance" DROP COLUMN "observation_count",
DROP COLUMN "last_observed_at";
