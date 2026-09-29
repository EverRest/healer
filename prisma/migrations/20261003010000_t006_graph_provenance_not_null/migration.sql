/*
  Warnings:

  - Made the column `layer` on table `graph_edge` required. This step will fail if there are existing NULL values in that column.
  - Made the column `provenance` on table `graph_edge` required. This step will fail if there are existing NULL values in that column.
  - Made the column `strength` on table `graph_edge` required. This step will fail if there are existing NULL values in that column.
  - Made the column `confidence` on table `graph_edge` required. This step will fail if there are existing NULL values in that column.
  - Made the column `layer` on table `graph_node` required. This step will fail if there are existing NULL values in that column.
  - Made the column `provenance` on table `graph_node` required. This step will fail if there are existing NULL values in that column.
  - Made the column `strength` on table `graph_node` required. This step will fail if there are existing NULL values in that column.
  - Made the column `confidence` on table `graph_node` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "architecture"."graph_edge" ALTER COLUMN "layer" SET NOT NULL,
ALTER COLUMN "provenance" SET NOT NULL,
ALTER COLUMN "strength" SET NOT NULL,
ALTER COLUMN "confidence" SET NOT NULL;

-- AlterTable
ALTER TABLE "architecture"."graph_node" ALTER COLUMN "layer" SET NOT NULL,
ALTER COLUMN "provenance" SET NOT NULL,
ALTER COLUMN "strength" SET NOT NULL,
ALTER COLUMN "confidence" SET NOT NULL;

-- CheckConstraint
-- data-model.md graph_node "Constraints", written as boolean expressions (`NOT a OR b`) since
-- Postgres has no `IMPLIES`. Only graph_node gets these two: graph_edge has no
-- observation_ref/actor_ref column for either to reference — its provenance is the maximum over
-- edge_provenance instead (T011). "Every non-human class carries an observation."
ALTER TABLE "architecture"."graph_node" ADD CONSTRAINT "graph_node_observation_ref_check"
  CHECK (provenance IN ('human_authored', 'human_confirmed') OR observation_ref IS NOT NULL);

-- CheckConstraint
-- "Every human class carries a named actor." An element with no provenance source at all cannot
-- be persisted (FR-005, SC-001) — this pair plus the NOT NULL above is what proves it.
ALTER TABLE "architecture"."graph_node" ADD CONSTRAINT "graph_node_actor_ref_check"
  CHECK (provenance NOT IN ('human_authored', 'human_confirmed') OR actor_ref IS NOT NULL);
