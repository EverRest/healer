-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "policy";

-- CreateEnum
CREATE TYPE "policy"."policy_outcome" AS ENUM ('allow', 'require_approval', 'deny');

-- CreateEnum
CREATE TYPE "policy"."policy_reason_code" AS ENUM ('NO_MATCHING_RULE', 'CEILING_EXCEEDED', 'NO_AUTONOMY_GRANT', 'GRANT_REVOKED', 'ENVIRONMENT_RESTRICTED', 'COMPONENT_RESTRICTED', 'ISSUE_KIND_RESTRICTED', 'IMPACT_CLASS_RESTRICTED', 'EVIDENCE_INCOMPLETE', 'NO_ADOPTED_EXPECTATION', 'UNDO_NOT_ATTESTED', 'BUDGET_EXHAUSTED', 'RATE_LIMITED', 'COOLDOWN', 'ATTEMPT_CAP_REACHED', 'APPROVAL_REQUIRED', 'APPROVAL_EXPIRED', 'TARGET_BLOCKED', 'CATEGORY_NOT_ALLOWLISTED', 'TOPIC_BLOCKED');

-- CreateEnum
CREATE TYPE "policy"."policy_action_class" AS ENUM ('read_only', 'code_change', 'repository_write', 'reversible_remediation', 'merge', 'forward_deploy', 'irreversible');

-- CreateEnum
CREATE TYPE "policy"."approval_state" AS ENUM ('pending', 'approved', 'rejected', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "policy"."budget_scope_type" AS ENUM ('issue', 'tenant');

-- CreateEnum
CREATE TYPE "policy"."budget_limit_period" AS ENUM ('issue', 'day', 'month');

-- CreateTable
CREATE TABLE "policy"."policy_ruleset" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "published_by" TEXT NOT NULL,
    "supersedes_version" INTEGER,
    "conflict_warnings" JSONB NOT NULL,

    CONSTRAINT "policy_ruleset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy"."policy_rule" (
    "id" UUID NOT NULL,
    "ruleset_id" UUID NOT NULL,
    "rule_key" TEXT NOT NULL,
    "predicates" JSONB NOT NULL,
    "outcome" "policy"."policy_outcome" NOT NULL,
    "reason_code" "policy"."policy_reason_code" NOT NULL,
    "note" TEXT NOT NULL,

    CONSTRAINT "policy_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy"."policy_action" (
    "action_key" TEXT NOT NULL,
    "action_class" "policy"."policy_action_class" NOT NULL,
    "mutating" BOOLEAN NOT NULL,
    "owning_spec" TEXT NOT NULL,
    "introduced_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "policy_action_pkey" PRIMARY KEY ("action_key")
);

-- CreateTable
CREATE TABLE "policy"."autonomy_grant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "component_id" UUID,
    "environment" TEXT,
    "issue_kind" TEXT,
    "action_key" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "granted_by" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_by" TEXT,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "autonomy_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy"."autonomy_epoch" (
    "tenant_id" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "bumped_at" TIMESTAMPTZ(6) NOT NULL,
    "bumped_by" TEXT NOT NULL,
    "bump_reason" TEXT NOT NULL,

    CONSTRAINT "autonomy_epoch_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "policy"."policy_decision" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "issue_id" UUID,
    "workflow_run_id" UUID,
    "workflow_state" TEXT,
    "action_key" TEXT NOT NULL,
    "target_ref" TEXT,
    "fingerprint" TEXT,
    "proposal_digest" TEXT NOT NULL,
    "decision_input" JSONB NOT NULL,
    "ruleset_version" INTEGER NOT NULL,
    "matched_rule_keys" TEXT[],
    "outcome" "policy"."policy_outcome" NOT NULL,
    "reason_codes" TEXT[],
    "ceiling_applied" BOOLEAN NOT NULL,
    "budget_state" JSONB NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "invalidated_reason" TEXT,

    CONSTRAINT "policy_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy"."approval_request" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "workflow_run_id" UUID NOT NULL,
    "summary" JSONB NOT NULL,
    "evidence_ids" UUID[],
    "autonomy_epoch" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "state" "policy"."approval_state" NOT NULL,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy"."budget_limit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope_type" "policy"."budget_scope_type" NOT NULL,
    "scope_id" UUID,
    "period" "policy"."budget_limit_period" NOT NULL,
    "spend_limit" DECIMAL(12,4) NOT NULL,
    "time_limit_ms" INTEGER NOT NULL,
    "soft_threshold_pcts" INTEGER[],
    "escalation_attempt_cap" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "budget_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy"."action_limit" (
    "tenant_id" UUID NOT NULL,
    "action_key" TEXT NOT NULL,
    "rate_per_window" INTEGER NOT NULL,
    "window_seconds" INTEGER NOT NULL,
    "cooldown_seconds" INTEGER NOT NULL,
    "attempt_cap" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "action_limit_pkey" PRIMARY KEY ("tenant_id","action_key")
);

-- CreateTable
CREATE TABLE "policy"."budget_degradation_mark" (
    "tenant_id" UUID NOT NULL,
    "scope_type" "policy"."budget_scope_type" NOT NULL,
    "scope_id" UUID NOT NULL,
    "period_key" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "evidence_id" UUID NOT NULL,
    "marked_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_degradation_mark_pkey" PRIMARY KEY ("tenant_id","scope_type","scope_id","period_key","step")
);

-- CreateIndex
CREATE UNIQUE INDEX "policy_ruleset_tenant_id_version_key" ON "policy"."policy_ruleset"("tenant_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "policy_ruleset_tenant_id_digest_key" ON "policy"."policy_ruleset"("tenant_id", "digest");

-- CreateIndex
CREATE UNIQUE INDEX "policy_rule_ruleset_id_rule_key_key" ON "policy"."policy_rule"("ruleset_id", "rule_key");

-- CreateIndex
CREATE INDEX "policy_decision_tenant_id_action_key_target_ref_fingerprint_idx" ON "policy"."policy_decision"("tenant_id", "action_key", "target_ref", "fingerprint", "evaluated_at");

-- CreateIndex
CREATE INDEX "policy_decision_workflow_run_id_idx" ON "policy"."policy_decision"("workflow_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_decision_id_tenant_id_key" ON "policy"."policy_decision"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "approval_request_tenant_id_state_expires_at_idx" ON "policy"."approval_request"("tenant_id", "state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_decision_id_key" ON "policy"."approval_request"("decision_id");

-- CreateIndex
CREATE INDEX "budget_limit_tenant_id_scope_type_scope_id_idx" ON "policy"."budget_limit"("tenant_id", "scope_type", "scope_id");

-- AddForeignKey
ALTER TABLE "policy"."policy_rule" ADD CONSTRAINT "policy_rule_ruleset_id_fkey" FOREIGN KEY ("ruleset_id") REFERENCES "policy"."policy_ruleset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy"."autonomy_grant" ADD CONSTRAINT "autonomy_grant_action_key_fkey" FOREIGN KEY ("action_key") REFERENCES "policy"."policy_action"("action_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy"."approval_request" ADD CONSTRAINT "approval_request_decision_id_tenant_id_fkey" FOREIGN KEY ("decision_id", "tenant_id") REFERENCES "policy"."policy_decision"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- This should have had a FK from the start (batch 9 C1(b), review finding): `policy_decision`
-- carries `action_key` as plain text, exactly the pre-FK shape `autonomy_grant.action_key` above
-- was already fixed against. Without it, a decision could be recorded against an action key that
-- resolves to nothing in the registry — the FK makes that state unrepresentable at the database
-- layer, on top of `resolveRulesetAndEvaluate`'s own `UnregisteredActionError` refusal in code.
ALTER TABLE "policy"."policy_decision" ADD CONSTRAINT "policy_decision_action_key_fkey" FOREIGN KEY ("action_key") REFERENCES "policy"."policy_action"("action_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- policy_decision: consumed and invalidated are mutually exclusive terminal branches
-- (data-model.md "State transitions" — no edge between them; SC-001's reconciliation invariant
-- needs a decision to be unambiguously "executed" or not). A CHECK constraint covers INSERT as
-- well as UPDATE, which the append-only trigger below (added for T003) does not: the trigger only
-- fires on UPDATE/DELETE, so a single INSERT setting both columns non-null would otherwise slip
-- through untouched.
ALTER TABLE "policy"."policy_decision" ADD CONSTRAINT "policy_decision_terminal_xor" CHECK ("consumed_at" IS NULL OR "invalidated_reason" IS NULL);

-- autonomy_grant: partial index over live grants only (data-model.md — "Index (tenant_id,
-- action_key, environment) where revoked_at is null"). Prisma cannot express a partial index
-- (same limitation as workflow.workflow_run's deadline index, 001), so it is created directly
-- here rather than declared in schema.prisma.
CREATE INDEX "autonomy_grant_tenant_id_action_key_environment_active_idx" ON "policy"."autonomy_grant"("tenant_id", "action_key", "environment") WHERE "revoked_at" IS NULL;

-- Append-only enforcement (002 T003, R-01). policy_ruleset and policy_rule reject UPDATE and
-- DELETE outright — reuses reject_mutation_unless_privileged/reject_truncate_unless_privileged,
-- the same shared functions 001's migration (20260927000000_issue_evidence_audit) defined for
-- evidence_link/issue_event/audit_entry/workflow_transition; that migration runs before this one,
-- so the functions already exist. `SET LOCAL healer.privileged_write = 'on'` inside a transaction
-- is the one documented bypass (retention/tenant-deletion paths), never a silent escape hatch.
CREATE TRIGGER policy_ruleset_append_only
  BEFORE UPDATE OR DELETE ON "policy"."policy_ruleset"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER policy_ruleset_no_truncate
  BEFORE TRUNCATE ON "policy"."policy_ruleset"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER policy_rule_append_only
  BEFORE UPDATE OR DELETE ON "policy"."policy_rule"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER policy_rule_no_truncate
  BEFORE TRUNCATE ON "policy"."policy_rule"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

-- policy_decision: append-only except consumed_at and invalidated_reason, each of which may only
-- transition once, from null (data-model.md "State transitions" — a decision is issued once,
-- then moves to consumed OR invalidated, never back, never both changing after the first write to
-- either). DELETE is always rejected; every other column is frozen at insert.
--
-- Frozen by exclusion, not enumeration (batch 9 I3, review finding): comparing `to_jsonb(OLD)` and
-- `to_jsonb(NEW)` with the two mutable columns subtracted out means a column added later (Phase
-- 4's epoch, per `EvaluateAndBindResult`'s own doc comment) is frozen the moment it exists, rather
-- than defaulting to mutable until someone remembers to list it here too — the same "closed list
-- has exactly one authority" failure this migration's own column-by-column version used to repeat.
CREATE OR REPLACE FUNCTION reject_policy_decision_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('healer.privileged_write', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'policy_decision rows are append-only and cannot be deleted';
  END IF;
  IF (to_jsonb(OLD) - 'consumed_at' - 'invalidated_reason')
     IS DISTINCT FROM (to_jsonb(NEW) - 'consumed_at' - 'invalidated_reason') THEN
    RAISE EXCEPTION 'policy_decision rows are append-only; only consumed_at and invalidated_reason may change';
  END IF;
  IF OLD.consumed_at IS DISTINCT FROM NEW.consumed_at AND OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'policy_decision.consumed_at may only transition from null';
  END IF;
  IF OLD.invalidated_reason IS DISTINCT FROM NEW.invalidated_reason AND OLD.invalidated_reason IS NOT NULL THEN
    RAISE EXCEPTION 'policy_decision.invalidated_reason may only transition from null';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER policy_decision_append_only
  BEFORE UPDATE OR DELETE ON "policy"."policy_decision"
  FOR EACH ROW EXECUTE FUNCTION reject_policy_decision_mutation();

CREATE TRIGGER policy_decision_no_truncate
  BEFORE TRUNCATE ON "policy"."policy_decision"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();
