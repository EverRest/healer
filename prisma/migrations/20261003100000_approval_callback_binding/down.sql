DROP INDEX "workflow"."workflow_callback_approval_id_key";

ALTER TABLE "workflow"."workflow_callback" DROP COLUMN "approval_id";
