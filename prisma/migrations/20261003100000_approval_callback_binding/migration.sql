-- 002 Phase 7 review: an `approval` callback belongs to ONE approval request, so delivery is by
-- approval, never by run (a run-keyed delivery could consume or orphan another approval's callback).
-- Nullable: every other callback kind (012) has no approval. No FK to policy.approval_request on
-- purpose: 012 must not depend on 002's schema; the unique index is the binding.
ALTER TABLE "workflow"."workflow_callback" ADD COLUMN "approval_id" UUID;

CREATE UNIQUE INDEX "workflow_callback_approval_id_key" ON "workflow"."workflow_callback"("approval_id");
