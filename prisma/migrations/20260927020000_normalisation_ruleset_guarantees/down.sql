-- DropTrigger
DROP TRIGGER IF EXISTS normalisation_ruleset_append_only ON "issue"."normalisation_ruleset";
DROP TRIGGER IF EXISTS normalisation_ruleset_no_truncate ON "issue"."normalisation_ruleset";

-- DropForeignKey
ALTER TABLE "issue"."issue" DROP CONSTRAINT IF EXISTS "issue_ruleset_version_fkey";
