-- 001 T049/T050: "an issue with a live merged_into row is in state merged, and removing the row is
-- the unmerge" (data-model.md). The repository writes the row and the state in one transaction and
-- refuses a plain transition to `merged`; this is the second wall, for the writer that does not go
-- through the repository (docs/patterns.md "Enforce twice"). Two invariants, checked when the
-- transaction commits — the row and the state are necessarily written by different statements:
--   (A) state = 'merged'  =>  a live merged_into row names the issue as its subject;
--   (B) a live merged_into row  =>  the issue is 'merged' (or 'removed': tenant deletion may
--       remove a merged issue, and its row stays as it was).

-- Constraint triggers judge the rows written after them, not the ones already there. Before this
-- migration `transition(x, 'merged')` was a legal call that wrote the state and no relationship,
-- so a database may already hold exactly the shape the invariant forbids. Refuse to install over it,
-- naming what was found: the target of such a merge is unrecorded, so nothing here can repair it —
-- a person decides, per issue, whether it was really merged (write the row) or not (move the state).
DO $$
DECLARE
  orphaned integer;
  orphaned_example uuid;
  stray integer;
  stray_example uuid;
BEGIN
  SELECT count(*), min(i.id::text)::uuid INTO orphaned, orphaned_example
    FROM "issue"."issue" i
    WHERE i.state = 'merged'
      AND NOT EXISTS (
        SELECT 1 FROM "issue"."issue_relationship" r
        WHERE r.tenant_id = i.tenant_id AND r.issue_id = i.id
          AND r.kind = 'merged_into' AND r.removed_at IS NULL);
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'migration 20260928120000_merged_state_invariant: % issue(s) are merged but have no live merged_into row (for example %); resolve them by hand before applying', orphaned, orphaned_example;
  END IF;

  SELECT count(*), min(i.id::text)::uuid INTO stray, stray_example
    FROM "issue"."issue_relationship" r
    JOIN "issue"."issue" i ON i.id = r.issue_id AND i.tenant_id = r.tenant_id
    WHERE r.kind = 'merged_into' AND r.removed_at IS NULL
      AND i.state NOT IN ('merged', 'removed');
  IF stray > 0 THEN
    RAISE EXCEPTION 'migration 20260928120000_merged_state_invariant: % issue(s) have a live merged_into row but are neither merged nor removed (for example %); resolve them by hand before applying', stray, stray_example;
  END IF;
END;
$$;

-- data-model.md: other_issue_id <> issue_id. A merge into itself, and a relationship of any kind
-- from an issue to itself, is meaningless; the domain refuses the merge, this refuses the row.
-- Added NOT VALID and then validated, so the existing rows are checked under a weaker lock than
-- ADD CONSTRAINT would hold for the scan (this file runs as one transaction under `migrate deploy`,
-- so the ACCESS EXCLUSIVE lock of the ADD itself is still held until commit — the split pays off
-- if a large table ever needs this applied statement by statement).
ALTER TABLE "issue"."issue_relationship"
  ADD CONSTRAINT "issue_relationship_not_self" CHECK ("issue_id" <> "other_issue_id") NOT VALID;
ALTER TABLE "issue"."issue_relationship" VALIDATE CONSTRAINT "issue_relationship_not_self";

CREATE FUNCTION "issue"."enforce_merged_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject_id uuid;
  subject_tenant uuid;
  current_state "issue"."issue_state";
  has_live_row boolean;
BEGIN
  IF TG_TABLE_NAME = 'issue' THEN
    subject_id := NEW.id;
    subject_tenant := NEW.tenant_id;
  ELSE
    -- Only merged_into rows carry the invariant; correlations and recurrences are none of its business.
    IF (TG_OP = 'DELETE' AND OLD.kind <> 'merged_into')
       OR (TG_OP = 'INSERT' AND NEW.kind <> 'merged_into')
       OR (TG_OP = 'UPDATE' AND NEW.kind <> 'merged_into' AND OLD.kind <> 'merged_into') THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
      subject_id := OLD.issue_id;
      subject_tenant := OLD.tenant_id;
    ELSE
      subject_id := NEW.issue_id;
      subject_tenant := NEW.tenant_id;
    END IF;
  END IF;

  SELECT i.state INTO current_state FROM "issue"."issue" i
    WHERE i.id = subject_id AND i.tenant_id = subject_tenant;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM "issue"."issue_relationship" r
    WHERE r.tenant_id = subject_tenant AND r.issue_id = subject_id
      AND r.kind = 'merged_into' AND r.removed_at IS NULL
  ) INTO has_live_row;

  IF current_state = 'merged' AND NOT has_live_row THEN
    RAISE EXCEPTION 'issue % is merged but has no live merged_into relationship', subject_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF has_live_row AND current_state NOT IN ('merged', 'removed') THEN
    RAISE EXCEPTION 'issue % has a live merged_into relationship but is %, not merged', subject_id, current_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- The issue side fires only when `state` is written *and* changes — `recordOccurrence`, the
-- ingestion hot path, never touches it — or when a row is inserted already merged.
CREATE CONSTRAINT TRIGGER "issue_merged_state_insert"
  AFTER INSERT ON "issue"."issue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.state = 'merged')
  EXECUTE FUNCTION "issue"."enforce_merged_state"();

CREATE CONSTRAINT TRIGGER "issue_merged_state_update"
  AFTER UPDATE OF state ON "issue"."issue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION "issue"."enforce_merged_state"();

CREATE CONSTRAINT TRIGGER "issue_relationship_merged_state"
  AFTER INSERT OR UPDATE OR DELETE ON "issue"."issue_relationship"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "issue"."enforce_merged_state"();
