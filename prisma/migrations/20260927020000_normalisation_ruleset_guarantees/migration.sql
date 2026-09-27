-- AddForeignKey (001 T011, R-01): an issue's ruleset_version can only name a version that was
-- really published — a foreign key, not a plain int a caller could invent.
ALTER TABLE "issue"."issue" ADD CONSTRAINT "issue_ruleset_version_fkey" FOREIGN KEY ("ruleset_version") REFERENCES "issue"."normalisation_ruleset"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only enforcement for normalisation_ruleset (001 T011, R-01): "never edited; a change is
-- a new version" (data-model.md), enforced by the database using the same trigger functions 001
-- T003 already created (reject_mutation_unless_privileged / reject_truncate_unless_privileged) —
-- not recreated here. No privileged bypass is ever exercised for this table in practice: a
-- published ruleset is not tenant-scoped (tenant deletion never touches it) and nothing purges it
-- on a retention schedule; the bypass exists only because the trigger function is shared.
CREATE TRIGGER normalisation_ruleset_append_only
  BEFORE UPDATE OR DELETE ON "issue"."normalisation_ruleset"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER normalisation_ruleset_no_truncate
  BEFORE TRUNCATE ON "issue"."normalisation_ruleset"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();
