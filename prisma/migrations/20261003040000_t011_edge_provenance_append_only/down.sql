-- DropCheckConstraint
ALTER TABLE "architecture"."edge_provenance" DROP CONSTRAINT "edge_provenance_observation_ref_check";

-- DropTrigger
DROP TRIGGER "edge_provenance_maintain_edge_max" ON "architecture"."edge_provenance";

-- DropFunction
DROP FUNCTION "architecture"."maintain_graph_edge_provenance_max"();

-- DropTrigger
DROP TRIGGER "edge_provenance_no_truncate" ON "architecture"."edge_provenance";

-- DropTrigger
DROP TRIGGER "edge_provenance_append_only" ON "architecture"."edge_provenance";
