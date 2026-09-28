DROP TRIGGER IF EXISTS "issue_relationship_merged_state" ON "issue"."issue_relationship";
DROP TRIGGER IF EXISTS "issue_merged_state_update" ON "issue"."issue";
DROP TRIGGER IF EXISTS "issue_merged_state_insert" ON "issue"."issue";
DROP FUNCTION IF EXISTS "issue"."enforce_merged_state"();
ALTER TABLE "issue"."issue_relationship" DROP CONSTRAINT IF EXISTS "issue_relationship_not_self";
