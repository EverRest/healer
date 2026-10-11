-- CreateTrigger
-- Append-only (005 T009): reuses the generic `reject_mutation_unless_privileged()` /
-- `reject_truncate_unless_privileged()` from migration 20260927000000_issue_evidence_audit — NOT
-- redefined here — wired exactly as `edge_provenance` is in 20261003040000. The one documented
-- bypass is `withPrivilegedWrite` (@healer/prisma-client).
--
-- FOLLOW-UP (judgment call, recorded in the 005 report): T009 also names `retrieval_query` and
-- `retrieval_result`. Those tables are created in Phase 4 (T052), so they cannot be wired here. T052's
-- migration MUST add the same two triggers for each (`<table>_append_only` BEFORE UPDATE OR DELETE,
-- `<table>_no_truncate` BEFORE TRUNCATE) and extend knowledge-core.e2e.test.ts's append-only cases.
CREATE TRIGGER document_version_append_only
  BEFORE UPDATE OR DELETE ON "knowledge"."document_version"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER document_version_no_truncate
  BEFORE TRUNCATE ON "knowledge"."document_version"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER expected_behavior_version_append_only
  BEFORE UPDATE OR DELETE ON "knowledge"."expected_behavior_version"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER expected_behavior_version_no_truncate
  BEFORE TRUNCATE ON "knowledge"."expected_behavior_version"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER adoption_record_append_only
  BEFORE UPDATE OR DELETE ON "knowledge"."adoption_record"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER adoption_record_no_truncate
  BEFORE TRUNCATE ON "knowledge"."adoption_record"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

-- CreateFunction
-- anchor_grant is the one table here that is not purely append-only: its single permitted change is
-- the revocation, NULL -> (revoked_at, revoked_by, revocation_reason) all at once (the CHECKs in
-- 20261006000000 make "all at once" total), and only once. Every other column is fixed at grant, and
-- a grant is never deleted — a revoked grant must still resolve by id so a completed verification's
-- audit record stays readable (FR-013). The privileged bypass is the same one the generic functions
-- honour.
CREATE FUNCTION "knowledge"."guard_anchor_grant"() RETURNS trigger AS $$
BEGIN
  IF current_setting('healer.privileged_write', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'anchor_grant rows cannot be deleted; revoke instead';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.expected_behavior_version_id IS DISTINCT FROM OLD.expected_behavior_version_id
     OR NEW.adoption_record_id IS DISTINCT FROM OLD.adoption_record_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'anchor_grant is immutable except its one-time revocation (only revoked_* may change)';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (
       NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
       OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason) THEN
    RAISE EXCEPTION 'anchor_grant revocation is set once and cannot be changed or cleared';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CreateTrigger
CREATE TRIGGER anchor_grant_guard
  BEFORE UPDATE OR DELETE ON "knowledge"."anchor_grant"
  FOR EACH ROW EXECUTE FUNCTION "knowledge"."guard_anchor_grant"();

CREATE TRIGGER anchor_grant_no_truncate
  BEFORE TRUNCATE ON "knowledge"."anchor_grant"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();
