-- DropCheckConstraint
ALTER TABLE "architecture"."graph_edge" DROP CONSTRAINT "graph_edge_valid_version_order_check";

-- DropCheckConstraint
ALTER TABLE "architecture"."graph_node" DROP CONSTRAINT "graph_node_valid_version_order_check";

-- DropCheckConstraint
ALTER TABLE "architecture"."graph_edge" DROP CONSTRAINT "graph_edge_confidence_range_check";

-- DropCheckConstraint
ALTER TABLE "architecture"."graph_node" DROP CONSTRAINT "graph_node_confidence_range_check";
