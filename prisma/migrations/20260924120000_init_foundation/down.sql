-- DropForeignKey
ALTER TABLE "workflow"."workflow_transition" DROP CONSTRAINT "workflow_transition_run_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "workflow"."workflow_callback" DROP CONSTRAINT "workflow_callback_run_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant"."tenant_provider_config" DROP CONSTRAINT "tenant_provider_config_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant"."tenant_budget" DROP CONSTRAINT "tenant_budget_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "runner"."runner_registration" DROP CONSTRAINT "runner_registration_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "runner"."runner_capability_resolution" DROP CONSTRAINT "runner_capability_resolution_runner_id_fkey";

-- DropForeignKey
ALTER TABLE "agent"."agent_run" DROP CONSTRAINT "agent_run_prompt_version_id_fkey";

-- DropTable
DROP TABLE "workflow"."workflow_run";

-- DropTable
DROP TABLE "workflow"."workflow_transition";

-- DropTable
DROP TABLE "workflow"."workflow_callback";

-- DropTable
DROP TABLE "prompt"."prompt_version";

-- DropTable
DROP TABLE "tenant"."tenant";

-- DropTable
DROP TABLE "tenant"."tenant_provider_config";

-- DropTable
DROP TABLE "tenant"."tenant_budget";

-- DropTable
DROP TABLE "runner"."runner_registration";

-- DropTable
DROP TABLE "runner"."runner_capability_resolution";

-- DropTable
DROP TABLE "agent"."agent_run";

-- DropEnum
DROP TYPE "workflow"."transition_cause";

-- DropEnum
DROP TYPE "workflow"."callback_kind";

-- DropEnum
DROP TYPE "tenant"."tenant_status";

-- DropEnum
DROP TYPE "tenant"."provider_mode";

-- DropEnum
DROP TYPE "tenant"."provider_name";

-- DropEnum
DROP TYPE "tenant"."fallback_scope";

-- DropEnum
DROP TYPE "tenant"."budget_period";

-- DropEnum
DROP TYPE "runner"."runner_status";

-- DropEnum
DROP TYPE "runner"."capability_outcome";

-- DropEnum
DROP TYPE "agent"."agent_kind";
DROP INDEX IF EXISTS "workflow"."workflow_run_deadline_at_live_idx";
