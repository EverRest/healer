-- CreateTrigger
-- Append-only (004 T011, FR-008): reuses the existing generic trigger functions
-- `reject_mutation_unless_privileged()` / `reject_truncate_unless_privileged()` defined in
-- migration 20260927000000_issue_evidence_audit — NOT redefined here — mirroring exactly how
-- `evidence.evidence_link`'s triggers are wired in that same file. `SET LOCAL
-- healer.privileged_write = 'on'` via `withPrivilegedWrite` (@healer/prisma-client) is the one
-- documented bypass; a pure insert-only table should never need it.
CREATE TRIGGER edge_provenance_append_only
  BEFORE UPDATE OR DELETE ON "architecture"."edge_provenance"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER edge_provenance_no_truncate
  BEFORE TRUNCATE ON "architecture"."edge_provenance"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

-- CreateFunction
-- graph_edge.strength/.confidence are maintained as the MAXIMUM over that edge's edge_provenance
-- rows (data-model.md) — a trigger-maintained denormalized column, updated at write time, not a
-- read-time MAX(): a purely read-time aggregate could never disagree with itself, so it would not
-- match the intent of a continuous `check:edge-strength-max` invariant that compares the
-- denormalized columns against the true max and can, in principle, find drift (a bug in this
-- trigger, or a privileged correction that skipped it). GREATEST() against the current column
-- value is used rather than re-aggregating all rows on every insert, since edge_provenance is
-- append-only and the column already holds the max of everything inserted before this row.
CREATE OR REPLACE FUNCTION architecture.maintain_graph_edge_provenance_max() RETURNS trigger AS $$
BEGIN
  UPDATE "architecture"."graph_edge"
  SET strength = GREATEST(strength, NEW.strength),
      confidence = GREATEST(confidence, NEW.confidence)
  WHERE id = NEW.edge_id AND tenant_id = NEW.tenant_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER edge_provenance_maintain_edge_max
  AFTER INSERT ON "architecture"."edge_provenance"
  FOR EACH ROW EXECUTE FUNCTION architecture.maintain_graph_edge_provenance_max();
