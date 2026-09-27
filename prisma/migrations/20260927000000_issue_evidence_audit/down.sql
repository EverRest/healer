-- AlterEnum
BEGIN;
CREATE TYPE "agent"."agent_kind_new" AS ENUM ('investigator', 'change', 'verifier', 'support');
ALTER TABLE "agent"."agent_run" ALTER COLUMN "agent_kind" TYPE "agent"."agent_kind_new" USING ("agent_kind"::text::"agent"."agent_kind_new");
ALTER TYPE "agent"."agent_kind" RENAME TO "agent_kind_old";
ALTER TYPE "agent"."agent_kind_new" RENAME TO "agent_kind";
DROP TYPE "agent"."agent_kind_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "issue"."issue_relationship" DROP CONSTRAINT "issue_relationship_issue_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "issue"."issue_relationship" DROP CONSTRAINT "issue_relationship_other_issue_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "issue"."issue_event" DROP CONSTRAINT "issue_event_issue_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "evidence"."evidence" DROP CONSTRAINT "evidence_issue_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "evidence"."evidence_link" DROP CONSTRAINT "evidence_link_evidence_id_tenant_id_fkey";

-- DropTable
DROP TABLE "issue"."issue";

-- DropTable
DROP TABLE "issue"."issue_relationship";

-- DropTable
DROP TABLE "issue"."issue_event";

-- DropTable
DROP TABLE "issue"."ingestion_delivery";

-- DropTable
DROP TABLE "issue"."normalisation_ruleset";

-- DropTable
DROP TABLE "evidence"."evidence";

-- DropTable
DROP TABLE "evidence"."evidence_link";

-- DropTable
DROP TABLE "audit"."audit_entry";

-- DropTable
DROP TABLE "audit"."deletion_tombstone";

-- DropEnum
DROP TYPE "issue"."issue_kind";

-- DropEnum
DROP TYPE "issue"."issue_severity";

-- DropEnum
DROP TYPE "issue"."issue_state";

-- DropEnum
DROP TYPE "issue"."issue_relationship_kind";

-- DropEnum
DROP TYPE "issue"."issue_event_type";

-- DropEnum
DROP TYPE "issue"."issue_event_cause";

-- DropEnum
DROP TYPE "issue"."ingestion_outcome";

-- DropEnum
DROP TYPE "evidence"."evidence_type";

-- DropEnum
DROP TYPE "evidence"."ref_state";

-- DropEnum
DROP TYPE "evidence"."conclusion_type";

-- DropEnum
DROP TYPE "evidence"."evidence_relation";

-- DropEnum
DROP TYPE "audit"."audit_actor_type";

-- The append-only trigger functions (001 T003) are not owned by any one table, so dropping the
-- tables above does not remove them; CASCADE also drops the triggers, including
-- workflow_transition_append_only / workflow_transition_no_truncate on workflow.workflow_transition
-- — a table this migration does not own or drop, since it was created by 012's migration.
DROP FUNCTION IF EXISTS reject_mutation_unless_privileged() CASCADE;
DROP FUNCTION IF EXISTS reject_evidence_mutation() CASCADE;
DROP FUNCTION IF EXISTS reject_truncate_unless_privileged() CASCADE;
