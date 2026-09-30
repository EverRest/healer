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
-- trigger, or a privileged correction that skipped it).
--
-- Review fix (post-004 T011): the first version of this function did two things wrong. (1) It
-- had no `valid_to_version` filter, so it silently rewrote *closed/historical* edge rows too —
-- reproduced by closing an edge, then inserting a new edge_provenance row against that same
-- edge_id: the closed row's strength/confidence changed, which breaks FR-014/SC-005 (a pinned
-- query at an old version must stay stable). The WHERE clause below now only ever touches the
-- open row for this edge_id. (2) It computed `GREATEST(strength, NEW.strength)` against the
-- edge's *current* column value rather than a true MAX() over edge_provenance rows — correct only
-- if the edge's founding strength/confidence (set at the edge's own INSERT, before any
-- edge_provenance row exists) always agrees with what edge_provenance actually records, which
-- nothing enforces yet (T040's `check:edge-strength-max` is the future backstop for that, not
-- built in this phase). A real aggregate is correct regardless of the founding value.
CREATE OR REPLACE FUNCTION architecture.maintain_graph_edge_provenance_max() RETURNS trigger AS $$
BEGIN
  UPDATE "architecture"."graph_edge"
  SET strength = (
        SELECT MAX(strength) FROM "architecture"."edge_provenance"
        WHERE edge_id = NEW.edge_id AND tenant_id = NEW.tenant_id
      ),
      confidence = (
        SELECT MAX(confidence) FROM "architecture"."edge_provenance"
        WHERE edge_id = NEW.edge_id AND tenant_id = NEW.tenant_id
      )
  WHERE id = NEW.edge_id AND tenant_id = NEW.tenant_id AND valid_to_version = 2147483647;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER edge_provenance_maintain_edge_max
  AFTER INSERT ON "architecture"."edge_provenance"
  FOR EACH ROW EXECUTE FUNCTION architecture.maintain_graph_edge_provenance_max();

-- CheckConstraint
-- Review fix (post-004 T011): edge_provenance had no equivalent of graph_node's "every non-human
-- provenance carries an observation" CHECK (T006) — a `derived_from_trace` row with
-- `observation_ref IS NULL` was accepted. `edge_provenance` has no `actor_ref` column (see
-- data-model.md and this feature's own implementation notes), so only the observation half of
-- graph_node's pair applies here; whether graph_edge/edge_provenance need an actor-naming path at
-- all is a separate, still-open spec question, not resolved by this constraint.
ALTER TABLE "architecture"."edge_provenance" ADD CONSTRAINT "edge_provenance_observation_ref_check"
  CHECK (provenance IN ('human_authored', 'human_confirmed') OR observation_ref IS NOT NULL);
