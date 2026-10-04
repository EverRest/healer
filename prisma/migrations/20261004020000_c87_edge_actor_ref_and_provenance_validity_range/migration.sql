/*
  C-87 (docs/decisions.md): graph_edge/edge_provenance gain the same actor_ref/observation_ref
  pair graph_node already has, plus R-04a's validity range on edge_provenance. edge_provenance is
  not empty-safe for the two new NOT NULL version columns in a database that already has rows —
  this migration assumes none exist yet (the append-only table is brand new as of 004 Phase 3),
  matching every other "add a required column" migration in this schema's history
  (20261003020000_t008_graph_versioning did the identical thing to graph_edge/graph_node
  themselves).

  Warnings:

  - Added the required column `valid_from_version` to the `edge_provenance` table without a
    default value. This is not possible if the table is not empty.
*/

-- AlterTable
ALTER TABLE "architecture"."graph_edge"
  ADD COLUMN "observation_ref" UUID,
  ADD COLUMN "actor_ref" TEXT;

-- AlterTable
ALTER TABLE "architecture"."edge_provenance"
  ADD COLUMN "actor_ref" TEXT,
  ADD COLUMN "valid_from_version" INTEGER NOT NULL,
  ADD COLUMN "valid_to_version" INTEGER NOT NULL DEFAULT 2147483647;

-- CheckConstraint
-- Mirrors graph_node's T006 pair exactly (data-model.md "Constraints"; Prisma cannot express
-- CHECK). "Every non-human class carries an observation."
ALTER TABLE "architecture"."graph_edge" ADD CONSTRAINT "graph_edge_observation_ref_check"
  CHECK (provenance IN ('human_authored', 'human_confirmed') OR observation_ref IS NOT NULL);

-- CheckConstraint
-- "Every human class carries a named actor."
ALTER TABLE "architecture"."graph_edge" ADD CONSTRAINT "graph_edge_actor_ref_check"
  CHECK (provenance NOT IN ('human_authored', 'human_confirmed') OR actor_ref IS NOT NULL);

-- CheckConstraint
-- edge_provenance's existing observation_ref CHECK (20261003040000_t011_edge_provenance_append_only)
-- is unchanged — a human row may still carry no observation. This is its new other half, now that
-- actor_ref exists here too: "every human-class provenance row carries a named actor."
ALTER TABLE "architecture"."edge_provenance" ADD CONSTRAINT "edge_provenance_actor_ref_check"
  CHECK (provenance NOT IN ('human_authored', 'human_confirmed') OR actor_ref IS NOT NULL);
