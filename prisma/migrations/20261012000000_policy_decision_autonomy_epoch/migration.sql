-- 002: a decision is bound to the autonomy epoch it was evaluated under (the epoch the evaluation
-- read, before it resolved anything). `consume` refuses a decision whose epoch is NULL or lower
-- than the tenant's current one, so a revocation kills every allow minted before it (R-13).
-- NULL on history and on a decision that never authorizes anything (a deny): fail closed.
-- The append-only trigger freezes every column but consumed_at/invalidated_reason by exclusion,
-- so this one is frozen at insert without touching the trigger.
ALTER TABLE "policy"."policy_decision" ADD COLUMN "autonomy_epoch" BIGINT;
