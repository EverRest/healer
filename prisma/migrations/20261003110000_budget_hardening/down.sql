DROP INDEX IF EXISTS "policy"."policy_decision_charge_request_key";
ALTER TABLE "policy"."policy_decision" DROP COLUMN IF EXISTS "request_key";
-- `ESCALATION_CAP_REACHED` stays on `policy_reason_code`: Postgres cannot drop an enum value.
