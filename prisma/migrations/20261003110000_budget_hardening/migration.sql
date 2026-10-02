-- 002 Phase 6 review fixes.
--
-- 1. `ESCALATION_CAP_REACHED` (T066): the escalation attempt cap gets its own reason code instead of
--    reusing the per-action `ATTEMPT_CAP_REACHED` of FR-014. (An enum value cannot be removed
--    again: the down-script leaves it, as 20260927000000's `agent_kind` addition does.)
ALTER TYPE "policy"."policy_reason_code" ADD VALUE 'ESCALATION_CAP_REACHED';

-- 2. `policy_decision.request_key` (T060): a charged step's idempotency key. The request digest is
--    the caller's proposal with every field the evaluation resolves (budget figures, escalation
--    count, autonomy level, action class) and the instant removed, so a retried EvaluateAndBind of
--    the *same step* maps to the same key however the budget moved in between. The partial unique
--    index is the backstop for the application-level lookup done under the charge lock: two
--    transactions cannot both mint a live charged decision for one (tenant, run, state, request).
--    The column is null for a decision that charged nothing, and the row leaves the index when it
--    is invalidated (an abandoned charge released, an epoch bump), so a legitimate re-request after
--    that is a new decision. The append-only trigger compares every column but `consumed_at` and
--    `invalidated_reason`, and `request_key` is written once, at insert.
ALTER TABLE "policy"."policy_decision" ADD COLUMN "request_key" TEXT;

CREATE UNIQUE INDEX "policy_decision_charge_request_key"
  ON "policy"."policy_decision" ("tenant_id", "workflow_run_id", "workflow_state", "request_key")
  WHERE "outcome" = 'allow'
    AND "request_key" IS NOT NULL
    AND "workflow_run_id" IS NOT NULL
    AND "workflow_state" IS NOT NULL
    AND "invalidated_reason" IS NULL;
