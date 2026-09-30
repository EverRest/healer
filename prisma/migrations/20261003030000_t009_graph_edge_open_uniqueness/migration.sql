-- CreateIndex
-- At most one open row per logical edge (004 T009, data-model.md graph_edge "Indexes"). Partial
-- on `valid_to_version = 2147483647` (R-04's "open" sentinel) — Prisma cannot express a partial
-- unique index, so it lives here only, same convention as issue.issue's fingerprint index and
-- graph_node's lifecycle_state index. Proven by graph-edge-open-uniqueness.e2e.test.ts's held-
-- transaction race (T009 red -> this migration green).
CREATE UNIQUE INDEX "graph_edge_tenant_id_from_node_id_to_node_id_edge_type_lay_key"
  ON "architecture"."graph_edge"("tenant_id", "from_node_id", "to_node_id", "edge_type", "layer")
  WHERE "valid_to_version" = 2147483647;
