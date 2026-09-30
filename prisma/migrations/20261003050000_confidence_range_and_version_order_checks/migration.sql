-- CheckConstraint
-- data-model.md graph_node: "confidence | smallint | integer 0-100" — never previously a CHECK.
-- Cheap insurance against a bug (or a manual correction) writing an out-of-range value that
-- every consumer of confidence (R-06's uncertainty penalty, FR-015's weakest-edge computation)
-- silently trusts.
ALTER TABLE "architecture"."graph_node" ADD CONSTRAINT "graph_node_confidence_range_check"
  CHECK (confidence BETWEEN 0 AND 100);

-- CheckConstraint
ALTER TABLE "architecture"."graph_edge" ADD CONSTRAINT "graph_edge_confidence_range_check"
  CHECK (confidence BETWEEN 0 AND 100);

-- CheckConstraint
-- R-04: a validity range with valid_from_version > valid_to_version is not a range at all — it
-- can never match any pinned-version query ($version BETWEEN valid_from_version AND
-- valid_to_version), so it would be a row silently invisible to every traversal rather than a
-- loud error at write time.
ALTER TABLE "architecture"."graph_node" ADD CONSTRAINT "graph_node_valid_version_order_check"
  CHECK (valid_from_version <= valid_to_version);

-- CheckConstraint
ALTER TABLE "architecture"."graph_edge" ADD CONSTRAINT "graph_edge_valid_version_order_check"
  CHECK (valid_from_version <= valid_to_version);
