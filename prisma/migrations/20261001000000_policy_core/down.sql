-- Reverse of policy_decision's restricted-update trigger and function.
DROP TRIGGER IF EXISTS policy_decision_no_truncate ON "policy"."policy_decision";
DROP TRIGGER IF EXISTS policy_decision_append_only ON "policy"."policy_decision";
DROP FUNCTION IF EXISTS reject_policy_decision_mutation();

-- Reverse of policy_rule / policy_ruleset append-only triggers. The shared functions
-- (reject_mutation_unless_privileged, reject_truncate_unless_privileged) are owned by 001's
-- migration (20260927000000_issue_evidence_audit) and are not dropped here.
DROP TRIGGER IF EXISTS policy_rule_no_truncate ON "policy"."policy_rule";
DROP TRIGGER IF EXISTS policy_rule_append_only ON "policy"."policy_rule";
DROP TRIGGER IF EXISTS policy_ruleset_no_truncate ON "policy"."policy_ruleset";
DROP TRIGGER IF EXISTS policy_ruleset_append_only ON "policy"."policy_ruleset";

-- DropIndex
DROP INDEX IF EXISTS "policy"."autonomy_grant_tenant_id_action_key_environment_active_idx";

-- DropForeignKey
ALTER TABLE "policy"."approval_request" DROP CONSTRAINT "approval_request_decision_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "policy"."autonomy_grant" DROP CONSTRAINT "autonomy_grant_action_key_fkey";

-- DropForeignKey
ALTER TABLE "policy"."policy_rule" DROP CONSTRAINT "policy_rule_ruleset_id_fkey";

-- DropTable
DROP TABLE "policy"."budget_degradation_mark";

-- DropTable
DROP TABLE "policy"."action_limit";

-- DropTable
DROP TABLE "policy"."budget_limit";

-- DropTable
DROP TABLE "policy"."approval_request";

-- DropTable
DROP TABLE "policy"."policy_decision";

-- DropTable
DROP TABLE "policy"."autonomy_epoch";

-- DropTable
DROP TABLE "policy"."autonomy_grant";

-- DropTable
DROP TABLE "policy"."policy_action";

-- DropTable
DROP TABLE "policy"."policy_rule";

-- DropTable
DROP TABLE "policy"."policy_ruleset";

-- DropEnum
DROP TYPE "policy"."budget_limit_period";

-- DropEnum
DROP TYPE "policy"."budget_scope_type";

-- DropEnum
DROP TYPE "policy"."approval_state";

-- DropEnum
DROP TYPE "policy"."policy_action_class";

-- DropEnum
DROP TYPE "policy"."policy_reason_code";

-- DropEnum
DROP TYPE "policy"."policy_outcome";
