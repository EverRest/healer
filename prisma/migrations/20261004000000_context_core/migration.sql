-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "context";

-- CreateEnum
CREATE TYPE "context"."collector_key" AS ENUM ('loki_logs', 'otel_traces', 'prometheus_metrics', 'grafana_alerts', 'gitlab_commits', 'gitlab_merge_requests', 'gitlab_deployments', 'config_flags', 'source_file');

-- CreateEnum
CREATE TYPE "context"."item_class" AS ENUM ('error_signature', 'stack_frame', 'trace_shape', 'metric_delta', 'deploy_ref', 'commit_ref', 'test_result', 'file_path', 'pull_request_ref', 'config_key_ref', 'knowledge_ref', 'tool_output_summary');

-- CreateEnum
CREATE TYPE "context"."source_status" AS ENUM ('collected', 'partial', 'unavailable', 'timed_out', 'withheld', 'not_attempted');

-- CreateEnum
CREATE TYPE "context"."gap_reason_code" AS ENUM ('source_unreachable', 'auth_revoked', 'timeout', 'retention_exceeded', 'capability_unavailable', 'budget_exhausted', 'redaction_withheld', 'schema_rejected', 'empty_result');

-- CreateEnum
CREATE TYPE "context"."follow_up_reason" AS ENUM ('inspect_stack_frame_source', 'widen_time_window', 'probe_missing_source');

-- CreateEnum
CREATE TYPE "context"."context_budget_state" AS ENUM ('within', 'degraded', 'budget_limited');

-- CreateEnum
CREATE TYPE "context"."component_attribution" AS ENUM ('resolved', 'fallback', 'unknown');

-- CreateEnum
CREATE TYPE "context"."inclusion_state" AS ENUM ('included', 'excluded');

-- CreateEnum
CREATE TYPE "context"."pass_outcome" AS ENUM ('completed', 'partial', 'deadline_expired', 'runner_unavailable');

-- CreateTable
CREATE TABLE "context"."context_snapshot" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "predecessor_id" UUID,
    "collected_at" TIMESTAMPTZ(6) NOT NULL,
    "window_from" TIMESTAMPTZ(6) NOT NULL,
    "window_to" TIMESTAMPTZ(6) NOT NULL,
    "plan_digest" TEXT NOT NULL,
    "collection_ruleset_version" INTEGER NOT NULL,
    "ranking_ruleset_version" INTEGER NOT NULL,
    "redaction_ruleset_version" INTEGER NOT NULL,
    "normalisation_ruleset_version" INTEGER NOT NULL,
    "contract_version" INTEGER NOT NULL,
    "runner_id" UUID NOT NULL,
    "runner_image_version" TEXT NOT NULL,
    "completeness" JSONB NOT NULL,
    "inclusion_cut_score" INTEGER,
    "budget_state" "context"."context_budget_state" NOT NULL,
    "finalised_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "context_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context"."collection_pass" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "pass_ordinal" INTEGER NOT NULL,
    "plan_digest" TEXT NOT NULL,
    "requested_plan" JSONB NOT NULL,
    "resolved_plan" JSONB NOT NULL,
    "requested_by_step" TEXT NOT NULL,
    "request_reason" "context"."follow_up_reason",
    "workflow_run_id" UUID NOT NULL,
    "callback_id" UUID NOT NULL,
    "dispatched_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "outcome" "context"."pass_outcome" NOT NULL,

    CONSTRAINT "collection_pass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context"."source_outcome" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pass_id" UUID NOT NULL,
    "collector_key" "context"."collector_key" NOT NULL,
    "status" "context"."source_status" NOT NULL,
    "reason_code" "context"."gap_reason_code",
    "item_count" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "gap_evidence_id" UUID,

    CONSTRAINT "source_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context"."context_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "pass_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "item_class" "context"."item_class" NOT NULL,
    "collector_key" "context"."collector_key" NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "occurrence_count" BIGINT NOT NULL,
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "component_id" UUID,
    "component_attribution" "context"."component_attribution" NOT NULL,
    "relevance_score" INTEGER NOT NULL,
    "ranking_terms" JSONB NOT NULL,
    "inclusion_state" "context"."inclusion_state" NOT NULL,
    "redaction_dominated" BOOLEAN NOT NULL,

    CONSTRAINT "context_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context"."collection_ruleset" (
    "version" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "collection_ruleset_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "context"."ranking_ruleset" (
    "version" INTEGER NOT NULL,
    "terms" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "ranking_ruleset_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "context"."redaction_ruleset" (
    "version" INTEGER NOT NULL,
    "detectors" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "runner_min_image_version" TEXT NOT NULL,

    CONSTRAINT "redaction_ruleset_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "context"."collector_registration" (
    "collector_key" "context"."collector_key" NOT NULL,
    "item_classes" "context"."item_class"[],
    "parameter_schema" JSONB NOT NULL,
    "default_timeout_ms" INTEGER NOT NULL,
    "required_capability" TEXT NOT NULL,
    "plane" TEXT NOT NULL DEFAULT 'execution',
    "introduced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collector_registration_pkey" PRIMARY KEY ("collector_key")
);

-- CreateTable
CREATE TABLE "context"."boundary_rejection" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "runner_id" UUID NOT NULL,
    "pass_id" UUID,
    "contract_version" INTEGER NOT NULL,
    "schema_error_paths" TEXT[],
    "payload_digest" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "boundary_rejection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "context_snapshot_tenant_id_issue_id_version_idx" ON "context"."context_snapshot"("tenant_id", "issue_id", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "context_snapshot_id_tenant_id_key" ON "context"."context_snapshot"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "context_snapshot_tenant_id_issue_id_version_key" ON "context"."context_snapshot"("tenant_id", "issue_id", "version");

-- CreateIndex
CREATE INDEX "collection_pass_tenant_id_snapshot_id_idx" ON "context"."collection_pass"("tenant_id", "snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_pass_id_tenant_id_key" ON "context"."collection_pass"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_pass_snapshot_id_pass_ordinal_key" ON "context"."collection_pass"("snapshot_id", "pass_ordinal");

-- CreateIndex
CREATE INDEX "source_outcome_tenant_id_pass_id_idx" ON "context"."source_outcome"("tenant_id", "pass_id");

-- CreateIndex
CREATE INDEX "context_item_tenant_id_snapshot_id_idx" ON "context"."context_item"("tenant_id", "snapshot_id");

-- CreateIndex
CREATE INDEX "context_item_snapshot_id_inclusion_state_relevance_score_la_idx" ON "context"."context_item"("snapshot_id", "inclusion_state", "relevance_score" DESC, "last_observed_at", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "context_item_snapshot_id_dedup_key_key" ON "context"."context_item"("snapshot_id", "dedup_key");

-- CreateIndex
CREATE INDEX "boundary_rejection_tenant_id_received_at_idx" ON "context"."boundary_rejection"("tenant_id", "received_at");

-- AddForeignKey
ALTER TABLE "context"."context_snapshot" ADD CONSTRAINT "context_snapshot_issue_id_tenant_id_fkey" FOREIGN KEY ("issue_id", "tenant_id") REFERENCES "issue"."issue"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context"."collection_pass" ADD CONSTRAINT "collection_pass_snapshot_id_tenant_id_fkey" FOREIGN KEY ("snapshot_id", "tenant_id") REFERENCES "context"."context_snapshot"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context"."collection_pass" ADD CONSTRAINT "collection_pass_workflow_run_id_tenant_id_fkey" FOREIGN KEY ("workflow_run_id", "tenant_id") REFERENCES "workflow"."workflow_run"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context"."source_outcome" ADD CONSTRAINT "source_outcome_pass_id_tenant_id_fkey" FOREIGN KEY ("pass_id", "tenant_id") REFERENCES "context"."collection_pass"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context"."context_item" ADD CONSTRAINT "context_item_snapshot_id_tenant_id_fkey" FOREIGN KEY ("snapshot_id", "tenant_id") REFERENCES "context"."context_snapshot"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context"."context_item" ADD CONSTRAINT "context_item_pass_id_tenant_id_fkey" FOREIGN KEY ("pass_id", "tenant_id") REFERENCES "context"."collection_pass"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context"."context_item" ADD CONSTRAINT "context_item_evidence_id_tenant_id_fkey" FOREIGN KEY ("evidence_id", "tenant_id") REFERENCES "evidence"."evidence"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CheckConstraint
-- data-model.md: a gap record exists for every status but `collected`, and only for those (R-07).
ALTER TABLE "context"."source_outcome" ADD CONSTRAINT "source_outcome_gap_evidence_check"
  CHECK ((status = 'collected') = (gap_evidence_id IS NULL));

-- The collector set executes only in the customer's plane (data-model.md).
ALTER TABLE "context"."collector_registration" ADD CONSTRAINT "collector_registration_plane_check"
  CHECK (plane = 'execution');

-- CreateTrigger
-- Append-only (003 T004, FR-022): reuses the generic functions from migration
-- 20260927000000_issue_evidence_audit — NOT redefined here — exactly as edge_provenance does.
-- The rulesets are immutable (a change is a new version), the rest are historical records.
CREATE TRIGGER context_snapshot_append_only BEFORE UPDATE OR DELETE ON "context"."context_snapshot"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();
CREATE TRIGGER context_snapshot_no_truncate BEFORE TRUNCATE ON "context"."context_snapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER collection_pass_append_only BEFORE UPDATE OR DELETE ON "context"."collection_pass"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();
CREATE TRIGGER collection_pass_no_truncate BEFORE TRUNCATE ON "context"."collection_pass"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER source_outcome_append_only BEFORE UPDATE OR DELETE ON "context"."source_outcome"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();
CREATE TRIGGER source_outcome_no_truncate BEFORE TRUNCATE ON "context"."source_outcome"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER boundary_rejection_append_only BEFORE UPDATE OR DELETE ON "context"."boundary_rejection"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();
CREATE TRIGGER boundary_rejection_no_truncate BEFORE TRUNCATE ON "context"."boundary_rejection"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER collection_ruleset_append_only BEFORE UPDATE OR DELETE ON "context"."collection_ruleset"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();
CREATE TRIGGER collection_ruleset_no_truncate BEFORE TRUNCATE ON "context"."collection_ruleset"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER ranking_ruleset_append_only BEFORE UPDATE OR DELETE ON "context"."ranking_ruleset"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();
CREATE TRIGGER ranking_ruleset_no_truncate BEFORE TRUNCATE ON "context"."ranking_ruleset"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER redaction_ruleset_append_only BEFORE UPDATE OR DELETE ON "context"."redaction_ruleset"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();
CREATE TRIGGER redaction_ruleset_no_truncate BEFORE TRUNCATE ON "context"."redaction_ruleset"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();
