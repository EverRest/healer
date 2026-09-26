-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "agent";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "prompt";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "runner";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tenant";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "workflow";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "workflow"."transition_cause" AS ENUM ('job', 'callback', 'timeout', 'human', 'policy');

-- CreateEnum
CREATE TYPE "workflow"."callback_kind" AS ENUM ('ci_result', 'deploy_result', 'verification_tick', 'approval', 'runner_result');

-- CreateEnum
CREATE TYPE "tenant"."tenant_status" AS ENUM ('active', 'suspended', 'deleting');

-- CreateEnum
CREATE TYPE "tenant"."provider_mode" AS ENUM ('healer_provided', 'customer_byo');

-- CreateEnum
CREATE TYPE "tenant"."provider_name" AS ENUM ('anthropic', 'openai', 'bedrock', 'vertex');

-- CreateEnum
CREATE TYPE "tenant"."fallback_scope" AS ENUM ('within_tenant_providers');

-- CreateEnum
CREATE TYPE "tenant"."budget_period" AS ENUM ('day', 'month');

-- CreateEnum
CREATE TYPE "runner"."runner_status" AS ENUM ('active', 'degraded', 'refused', 'revoked');

-- CreateEnum
CREATE TYPE "runner"."capability_outcome" AS ENUM ('available', 'degraded', 'refused');

-- CreateEnum
CREATE TYPE "agent"."agent_kind" AS ENUM ('investigator', 'change', 'verifier', 'support');

-- CreateTable
CREATE TABLE "workflow"."workflow_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "definition_key" TEXT NOT NULL,
    "definition_version" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "awaiting" JSONB,
    "correlation_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deadline_at" TIMESTAMPTZ(6),
    "terminal_state" TEXT,

    CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow"."workflow_transition" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "cause" "workflow"."transition_cause" NOT NULL,
    "actor_ref" TEXT,
    "payload_digest" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow"."workflow_callback" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "workflow"."callback_kind" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "received_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "workflow_callback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt"."prompt_version" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "schema_ref" TEXT,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" TEXT NOT NULL,

    CONSTRAINT "prompt_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "tenant"."tenant_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_provider_config" (
    "tenant_id" UUID NOT NULL,
    "mode" "tenant"."provider_mode" NOT NULL,
    "provider" "tenant"."provider_name" NOT NULL,
    "endpoint" TEXT,
    "credential_ref" TEXT NOT NULL,
    "fallback_scope" "tenant"."fallback_scope" NOT NULL DEFAULT 'within_tenant_providers',
    "model_tier_map" JSONB NOT NULL,

    CONSTRAINT "tenant_provider_config_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_budget" (
    "tenant_id" UUID NOT NULL,
    "period" "tenant"."budget_period" NOT NULL,
    "spend_limit" DECIMAL(12,4) NOT NULL,
    "time_limit" INTEGER NOT NULL,
    "soft_threshold_pcts" INTEGER[],
    "degradation_order" TEXT[],
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_budget_pkey" PRIMARY KEY ("tenant_id","period")
);

-- CreateTable
CREATE TABLE "runner"."runner_registration" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "protocol_version" INTEGER NOT NULL,
    "capabilities" TEXT[],
    "image_version" TEXT NOT NULL,
    "status" "runner"."runner_status" NOT NULL,
    "last_heartbeat_at" TIMESTAMPTZ(6) NOT NULL,
    "refused_reason" TEXT,

    CONSTRAINT "runner_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runner"."runner_capability_resolution" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "runner_id" UUID NOT NULL,
    "requested_capability" TEXT NOT NULL,
    "outcome" "runner"."capability_outcome" NOT NULL,
    "reason" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runner_capability_resolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent"."agent_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "issue_id" UUID,
    "correlation_id" UUID NOT NULL,
    "agent_kind" "agent"."agent_kind" NOT NULL,
    "prompt_version_id" UUID NOT NULL,
    "model_id" TEXT NOT NULL,
    "provider" "tenant"."provider_name" NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost" DECIMAL(12,6) NOT NULL,
    "tool_calls" JSONB NOT NULL,
    "policy_decision_id" UUID,
    "outcome" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_run_tenant_id_state_idx" ON "workflow"."workflow_run"("tenant_id", "state");

-- CreateIndex
-- Partial on purpose: the deadline sweep reads live runs only, and a terminal run is
-- never woken. Not expressible in schema.prisma, so it lives here (data-model.md).
CREATE INDEX "workflow_run_deadline_at_live_idx" ON "workflow"."workflow_run"("deadline_at")
  WHERE "terminal_state" IS NULL;

-- CreateIndex
CREATE INDEX "workflow_transition_run_id_occurred_at_idx" ON "workflow"."workflow_transition"("run_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_callback_token_hash_key" ON "workflow"."workflow_callback"("token_hash");

-- CreateIndex
CREATE INDEX "workflow_callback_tenant_id_kind_idx" ON "workflow"."workflow_callback"("tenant_id", "kind");

-- CreateIndex
CREATE INDEX "workflow_callback_run_id_idx" ON "workflow"."workflow_callback"("run_id");

-- CreateIndex
CREATE INDEX "prompt_version_key_published_at_idx" ON "prompt"."prompt_version"("key", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_version_key_digest_key" ON "prompt"."prompt_version"("key", "digest");

-- CreateIndex
CREATE INDEX "runner_registration_tenant_id_status_idx" ON "runner"."runner_registration"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "runner_registration_tenant_id_name_key" ON "runner"."runner_registration"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "runner_capability_resolution_tenant_id_run_id_idx" ON "runner"."runner_capability_resolution"("tenant_id", "run_id");

-- CreateIndex
CREATE INDEX "agent_run_tenant_id_started_at_idx" ON "agent"."agent_run"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "agent_run_correlation_id_idx" ON "agent"."agent_run"("correlation_id");

-- AddForeignKey
ALTER TABLE "workflow"."workflow_transition" ADD CONSTRAINT "workflow_transition_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow"."workflow_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow"."workflow_callback" ADD CONSTRAINT "workflow_callback_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow"."workflow_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_provider_config" ADD CONSTRAINT "tenant_provider_config_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_budget" ADD CONSTRAINT "tenant_budget_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner"."runner_registration" ADD CONSTRAINT "runner_registration_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner"."runner_capability_resolution" ADD CONSTRAINT "runner_capability_resolution_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "runner"."runner_registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent"."agent_run" ADD CONSTRAINT "agent_run_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt"."prompt_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

