-- 002 T088 (FR-021, stage 0 S0-7): product bounds on the escalation attempt cap and on the
-- per-issue and per-tenant budgets. These are stop rules, not tuning knobs: a cap raised without
-- limit is an agent that never stops escalating, a budget raised without limit is a cost incident
-- with no ceiling. The maxima are LITERALS here and the same values are constants in code
-- (`packages/domain/policy/src/domain/budget-bounds.ts`); `budget-bounds.test.ts` fails if the two
-- ever disagree. The CHECKs bind a direct write too — the API refusing first is the second
-- mechanism, not the only one.
--
-- Spend maxima (issue / day / month): 50 / 500 / 5000. Time maxima in ms: 4 h / 24 h / 20 days.
-- Escalation attempt cap: 0..5.
ALTER TABLE "policy"."budget_limit"
  ADD CONSTRAINT "budget_limit_escalation_attempt_cap_bound"
    CHECK ("escalation_attempt_cap" BETWEEN 0 AND 5),
  ADD CONSTRAINT "budget_limit_spend_limit_bound"
    CHECK ("spend_limit" >= 0 AND "spend_limit" <=
      CASE "period" WHEN 'issue' THEN 50 WHEN 'day' THEN 500 ELSE 5000 END),
  ADD CONSTRAINT "budget_limit_time_limit_bound"
    CHECK ("time_limit_ms" >= 0 AND "time_limit_ms" <=
      CASE "period" WHEN 'issue' THEN 14400000 WHEN 'day' THEN 86400000 ELSE 1728000000 END),
  ADD CONSTRAINT "budget_limit_soft_threshold_pcts_range"
    CHECK ("soft_threshold_pcts" IS NULL OR
      (cardinality("soft_threshold_pcts") <= 5 AND 0 < ALL ("soft_threshold_pcts") AND 100 > ALL ("soft_threshold_pcts"))),
  ADD CONSTRAINT "budget_limit_scope_period"
    CHECK (("scope_type" = 'issue' AND "period" = 'issue') OR
           ("scope_type" = 'tenant' AND "period" IN ('day', 'month')));

-- One limit per (tenant, scope, period): the PUT is an upsert on this key. `scope_id` is NULL for
-- the tenant-wide row and for the per-issue default, so it is coalesced to a fixed UUID.
CREATE UNIQUE INDEX "budget_limit_scope_period_key"
  ON "policy"."budget_limit" ("tenant_id", "scope_type",
    COALESCE("scope_id", '00000000-0000-0000-0000-000000000000'::uuid), "period");
