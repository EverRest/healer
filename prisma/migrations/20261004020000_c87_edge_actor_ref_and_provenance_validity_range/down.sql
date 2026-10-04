-- CheckConstraint
ALTER TABLE "architecture"."edge_provenance" DROP CONSTRAINT "edge_provenance_actor_ref_check";

-- CheckConstraint
ALTER TABLE "architecture"."graph_edge" DROP CONSTRAINT "graph_edge_actor_ref_check";

-- CheckConstraint
ALTER TABLE "architecture"."graph_edge" DROP CONSTRAINT "graph_edge_observation_ref_check";

-- AlterTable
ALTER TABLE "architecture"."edge_provenance"
  DROP COLUMN "actor_ref",
  DROP COLUMN "valid_from_version",
  DROP COLUMN "valid_to_version";

-- AlterTable
ALTER TABLE "architecture"."graph_edge"
  DROP COLUMN "observation_ref",
  DROP COLUMN "actor_ref";
