ALTER TABLE "policy"."action_limit"
  DROP CONSTRAINT IF EXISTS "action_limit_rate_per_window_min",
  DROP CONSTRAINT IF EXISTS "action_limit_window_seconds_min",
  DROP CONSTRAINT IF EXISTS "action_limit_cooldown_seconds_min",
  DROP CONSTRAINT IF EXISTS "action_limit_attempt_cap_min";
