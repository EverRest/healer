DROP INDEX IF EXISTS "policy"."budget_limit_scope_period_key";
ALTER TABLE "policy"."budget_limit"
  DROP CONSTRAINT IF EXISTS "budget_limit_scope_period",
  DROP CONSTRAINT IF EXISTS "budget_limit_soft_threshold_pcts_range",
  DROP CONSTRAINT IF EXISTS "budget_limit_time_limit_bound",
  DROP CONSTRAINT IF EXISTS "budget_limit_spend_limit_bound",
  DROP CONSTRAINT IF EXISTS "budget_limit_escalation_attempt_cap_bound";
