-- 002 T054 (FR-014): minimum values for `policy.action_limit`. A rate of 0 or an attempt cap of 0
-- is a limit nobody can satisfy — a DENY-everything switch written as a limit — and a zero window
-- makes the count meaningless. The minima are LITERALS here and constants in code
-- (`packages/domain/policy/src/domain/action-limit.ts`, `ACTION_LIMIT_MINIMA`);
-- `action-limit.test.ts` fails if the two ever disagree. The CHECKs bind a direct write too.
ALTER TABLE "policy"."action_limit"
  ADD CONSTRAINT "action_limit_rate_per_window_min" CHECK ("rate_per_window" >= 1),
  ADD CONSTRAINT "action_limit_window_seconds_min" CHECK ("window_seconds" >= 1),
  ADD CONSTRAINT "action_limit_cooldown_seconds_min" CHECK ("cooldown_seconds" >= 0),
  ADD CONSTRAINT "action_limit_attempt_cap_min" CHECK ("attempt_cap" >= 1);
