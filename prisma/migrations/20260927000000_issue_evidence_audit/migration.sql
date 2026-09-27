-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "evidence";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "issue";

-- CreateEnum
CREATE TYPE "issue"."issue_kind" AS ENUM ('production_incident', 'user_report', 'monitoring_alert', 'regression', 'automated_detection', 'knowledge_drift');

-- CreateEnum
CREATE TYPE "issue"."issue_severity" AS ENUM ('critical', 'high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "issue"."issue_state" AS ENUM ('detected', 'investigating', 'diagnosed', 'acting', 'resolved', 'needs_human', 'stale', 'merged', 'removed');

-- CreateEnum
CREATE TYPE "issue"."issue_relationship_kind" AS ENUM ('related', 'recurrence_of', 'merged_into');

-- CreateEnum
CREATE TYPE "issue"."issue_event_type" AS ENUM ('signal_received', 'state_changed', 'merged', 'unmerged', 'related', 'action_taken', 'note');

-- CreateEnum
CREATE TYPE "issue"."issue_event_cause" AS ENUM ('ingestion', 'agent', 'human', 'policy', 'system');

-- CreateEnum
CREATE TYPE "issue"."ingestion_outcome" AS ENUM ('accepted', 'duplicate', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "evidence"."evidence_type" AS ENUM ('error_signature', 'trace_shape', 'metric_delta', 'deploy_ref', 'commit_ref', 'test_result', 'file_path', 'tool_output_summary', 'document_excerpt', 'collection_gap', 'budget_degradation', 'graph_fact');

-- CreateEnum
CREATE TYPE "evidence"."ref_state" AS ENUM ('linked', 'detached');

-- CreateEnum
CREATE TYPE "evidence"."conclusion_type" AS ENUM ('classification', 'diagnosis', 'hypothesis', 'impact', 'verification', 'support_answer', 'remediation');

-- CreateEnum
CREATE TYPE "evidence"."evidence_relation" AS ENUM ('supports', 'contradicts', 'contextualises');

-- CreateEnum
CREATE TYPE "audit"."audit_actor_type" AS ENUM ('agent', 'human', 'system', 'runner');

-- AlterEnum
ALTER TYPE "agent"."agent_kind" ADD VALUE 'test_author';

-- CreateTable
CREATE TABLE "issue"."issue" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "issue"."issue_kind" NOT NULL,
    "component_id" UUID,
    "environment" TEXT NOT NULL,
    "severity" "issue"."issue_severity" NOT NULL,
    "state" "issue"."issue_state" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ruleset_version" INTEGER NOT NULL,
    "occurrence_count" BIGINT NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "stale_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue"."issue_relationship" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "other_issue_id" UUID NOT NULL,
    "kind" "issue"."issue_relationship_kind" NOT NULL,
    "rule" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),

    CONSTRAINT "issue_relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue"."issue_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "type" "issue"."issue_event_type" NOT NULL,
    "from_state" "issue"."issue_state",
    "to_state" "issue"."issue_state",
    "cause" "issue"."issue_event_cause" NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue"."ingestion_delivery" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signal_count" INTEGER NOT NULL,
    "outcome" "issue"."ingestion_outcome" NOT NULL,

    CONSTRAINT "ingestion_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue"."normalisation_ruleset" (
    "version" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "normalisation_ruleset_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "evidence"."evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "type" "evidence"."evidence_type" NOT NULL,
    "source_system" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "source_label" TEXT NOT NULL,
    "excerpt" TEXT,
    "excerpt_truncated" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "produced_by_step" TEXT NOT NULL,
    "ref_state" "evidence"."ref_state" NOT NULL DEFAULT 'linked',
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence"."evidence_link" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "conclusion_type" "evidence"."conclusion_type" NOT NULL,
    "conclusion_id" UUID NOT NULL,
    "relation" "evidence"."evidence_relation" NOT NULL,
    "asserted_by_step" TEXT NOT NULL,
    "asserted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."audit_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_type" "audit"."audit_actor_type" NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence_ids" UUID[],
    "agent_run_id" UUID,
    "policy_decision_id" UUID,
    "outcome" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."deletion_tombstone" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "requested_by" TEXT NOT NULL,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "deletion_tombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "issue_tenant_id_state_last_seen_at_idx" ON "issue"."issue"("tenant_id", "state", "last_seen_at");

-- CreateIndex
CREATE INDEX "issue_tenant_id_component_id_last_seen_at_idx" ON "issue"."issue"("tenant_id", "component_id", "last_seen_at");

-- CreateIndex
-- Backs the composite FKs from issue_relationship, issue_event and evidence — id alone is
-- already unique via the primary key, but Postgres requires a unique constraint on exactly the
-- referenced column set (same pattern as 012's workflow_run).
CREATE UNIQUE INDEX "issue_id_tenant_id_key" ON "issue"."issue"("id", "tenant_id");

-- CreateIndex
-- Partial on purpose: a resolved issue must stay findable for FR-005's reopen window and a
-- stale one is "surfaced, not closed" (R-11) — only merged/removed issues drop out. Prisma
-- cannot express a partial index, so it lives here (data-model.md).
CREATE INDEX "issue_tenant_id_fingerprint_idx" ON "issue"."issue"("tenant_id", "fingerprint")
  WHERE "state" NOT IN ('merged', 'removed');

-- CreateIndex
CREATE INDEX "issue_relationship_tenant_id_other_issue_id_kind_idx" ON "issue"."issue_relationship"("tenant_id", "other_issue_id", "kind");

-- CreateIndex
-- An issue is a recurrence of at most one issue, and merged into at most one issue, while still
-- being able to be both — one partial unique index per single-valued relationship kind
-- (data-model.md). Not expressible as a Prisma `@@unique` (no WHERE clause support).
CREATE UNIQUE INDEX "issue_relationship_tenant_id_issue_id_kind_recurrence_key" ON "issue"."issue_relationship"("tenant_id", "issue_id")
  WHERE "kind" = 'recurrence_of' AND "removed_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "issue_relationship_tenant_id_issue_id_kind_merged_key" ON "issue"."issue_relationship"("tenant_id", "issue_id")
  WHERE "kind" = 'merged_into' AND "removed_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "issue_relationship_tenant_id_issue_id_other_kind_key" ON "issue"."issue_relationship"("tenant_id", "issue_id", "other_issue_id", "kind")
  WHERE "removed_at" IS NULL;

-- CreateIndex
CREATE INDEX "issue_event_tenant_id_issue_id_observed_at_idx" ON "issue"."issue_event"("tenant_id", "issue_id", "observed_at");

-- CreateIndex
CREATE INDEX "ingestion_delivery_tenant_id_received_at_idx" ON "issue"."ingestion_delivery"("tenant_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_delivery_tenant_id_provider_delivery_id_key" ON "issue"."ingestion_delivery"("tenant_id", "provider", "delivery_id");

-- CreateIndex
CREATE INDEX "evidence_tenant_id_issue_id_observed_at_idx" ON "evidence"."evidence"("tenant_id", "issue_id", "observed_at");

-- CreateIndex
-- Backs evidence_link's composite FK (see issue's unique index above for why).
CREATE UNIQUE INDEX "evidence_id_tenant_id_key" ON "evidence"."evidence"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_link_evidence_id_conclusion_id_relation_key" ON "evidence"."evidence_link"("evidence_id", "conclusion_id", "relation");

-- CreateIndex
CREATE INDEX "evidence_link_tenant_id_conclusion_type_conclusion_id_idx" ON "evidence"."evidence_link"("tenant_id", "conclusion_type", "conclusion_id");

-- CreateIndex
CREATE INDEX "audit_entry_tenant_id_occurred_at_idx" ON "audit"."audit_entry"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_entry_tenant_id_target_type_target_id_idx" ON "audit"."audit_entry"("tenant_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "deletion_tombstone_tenant_id_deleted_at_idx" ON "audit"."deletion_tombstone"("tenant_id", "deleted_at");

-- AddForeignKey
-- Composite FKs against issue(id, tenant_id) / evidence(id, tenant_id) — a row naming another
-- tenant's issue or evidence is rejected by Postgres, not merely mis-indexed (FR-048).
ALTER TABLE "issue"."issue_relationship" ADD CONSTRAINT "issue_relationship_issue_id_tenant_id_fkey" FOREIGN KEY ("issue_id", "tenant_id") REFERENCES "issue"."issue"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue"."issue_relationship" ADD CONSTRAINT "issue_relationship_other_issue_id_tenant_id_fkey" FOREIGN KEY ("other_issue_id", "tenant_id") REFERENCES "issue"."issue"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue"."issue_event" ADD CONSTRAINT "issue_event_issue_id_tenant_id_fkey" FOREIGN KEY ("issue_id", "tenant_id") REFERENCES "issue"."issue"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence"."evidence" ADD CONSTRAINT "evidence_issue_id_tenant_id_fkey" FOREIGN KEY ("issue_id", "tenant_id") REFERENCES "issue"."issue"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence"."evidence_link" ADD CONSTRAINT "evidence_link_evidence_id_tenant_id_fkey" FOREIGN KEY ("evidence_id", "tenant_id") REFERENCES "evidence"."evidence"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only enforcement (001 T003, R-03). "A repository that merely does not expose an update
-- method is one convenience method away from being wrong" (research.md) — enforced here, not in
-- application code. `SET LOCAL healer.privileged_write = 'on'` inside a transaction is the one
-- documented bypass, for the retention job's purge and the tenant-deletion path; every use of it
-- is itself an application-level audited action (R-03, R-12), never a silent escape hatch.
-- MUST be `SET LOCAL`, never bare `SET`: on a pooled connection a bare `SET` survives past the
-- transaction and leaks the bypass to whatever request reuses that connection next. T052/T053
-- (retention purge, tenant deletion) must wrap this in one helper that only ever issues
-- `SET LOCAL` — never call `current_setting`/`SET` ad hoc at each call site.
CREATE OR REPLACE FUNCTION reject_mutation_unless_privileged() RETURNS trigger AS $$
BEGIN
  IF current_setting('healer.privileged_write', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% rows are append-only and cannot be % (table: %)',
    TG_TABLE_NAME, lower(TG_OP), TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Row-level triggers cover UPDATE/DELETE; TRUNCATE bypasses row-level triggers entirely in
-- Postgres, so it needs its own statement-level trigger per table.
CREATE OR REPLACE FUNCTION reject_truncate_unless_privileged() RETURNS trigger AS $$
BEGIN
  IF current_setting('healer.privileged_write', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% rows are append-only and cannot be truncated', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_link_append_only
  BEFORE UPDATE OR DELETE ON "evidence"."evidence_link"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER evidence_link_no_truncate
  BEFORE TRUNCATE ON "evidence"."evidence_link"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER issue_event_append_only
  BEFORE UPDATE OR DELETE ON "issue"."issue_event"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER issue_event_no_truncate
  BEFORE TRUNCATE ON "issue"."issue_event"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER audit_entry_append_only
  BEFORE UPDATE OR DELETE ON "audit"."audit_entry"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER audit_entry_no_truncate
  BEFORE TRUNCATE ON "audit"."audit_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

-- workflow.workflow_transition was declared append-only in schema.prisma (012) at the time this
-- migration's enforcement functions were written, but the trigger itself was never added — caught
-- by review, not by any test, because nothing checked the claim against the trigger catalogue.
CREATE TRIGGER workflow_transition_append_only
  BEFORE UPDATE OR DELETE ON "workflow"."workflow_transition"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER workflow_transition_no_truncate
  BEFORE TRUNCATE ON "workflow"."workflow_transition"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

-- evidence.evidence: the one exception is ref_state moving linked -> detached (R-03, R-04).
-- Everything else about a row, including ref_state moving any other direction, is rejected the
-- same as a fully immutable table; DELETE always needs the privileged bypass above.
CREATE OR REPLACE FUNCTION reject_evidence_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('healer.privileged_write', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence rows are append-only and cannot be deleted';
  END IF;
  IF NOT (
    OLD.id IS NOT DISTINCT FROM NEW.id AND
    OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id AND
    OLD.issue_id IS NOT DISTINCT FROM NEW.issue_id AND
    OLD.type IS NOT DISTINCT FROM NEW.type AND
    OLD.source_system IS NOT DISTINCT FROM NEW.source_system AND
    OLD.source_ref IS NOT DISTINCT FROM NEW.source_ref AND
    OLD.source_label IS NOT DISTINCT FROM NEW.source_label AND
    OLD.excerpt IS NOT DISTINCT FROM NEW.excerpt AND
    OLD.excerpt_truncated IS NOT DISTINCT FROM NEW.excerpt_truncated AND
    OLD.payload IS NOT DISTINCT FROM NEW.payload AND
    OLD.produced_by_step IS NOT DISTINCT FROM NEW.produced_by_step AND
    OLD.observed_at IS NOT DISTINCT FROM NEW.observed_at AND
    OLD.received_at IS NOT DISTINCT FROM NEW.received_at AND
    OLD.expires_at IS NOT DISTINCT FROM NEW.expires_at
  ) THEN
    RAISE EXCEPTION 'evidence rows are append-only; only ref_state may change';
  END IF;
  IF OLD.ref_state IS DISTINCT FROM NEW.ref_state
     AND NOT (OLD.ref_state = 'linked' AND NEW.ref_state = 'detached') THEN
    RAISE EXCEPTION 'evidence.ref_state may only move linked -> detached';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_append_only
  BEFORE UPDATE OR DELETE ON "evidence"."evidence"
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation();

CREATE TRIGGER evidence_no_truncate
  BEFORE TRUNCATE ON "evidence"."evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

