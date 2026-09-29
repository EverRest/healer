-- DropCheckConstraint
ALTER TABLE "architecture"."graph_node" DROP CONSTRAINT "graph_node_actor_ref_check";

-- DropCheckConstraint
ALTER TABLE "architecture"."graph_node" DROP CONSTRAINT "graph_node_observation_ref_check";

-- AlterTable
ALTER TABLE "architecture"."graph_node" ALTER COLUMN "layer" DROP NOT NULL,
ALTER COLUMN "provenance" DROP NOT NULL,
ALTER COLUMN "strength" DROP NOT NULL,
ALTER COLUMN "confidence" DROP NOT NULL;

-- AlterTable
ALTER TABLE "architecture"."graph_edge" ALTER COLUMN "layer" DROP NOT NULL,
ALTER COLUMN "provenance" DROP NOT NULL,
ALTER COLUMN "strength" DROP NOT NULL,
ALTER COLUMN "confidence" DROP NOT NULL;
