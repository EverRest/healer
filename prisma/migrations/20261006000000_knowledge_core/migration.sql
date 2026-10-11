-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "knowledge";

-- CreateFunction
-- The one definition of a section's lexical document. The 'simple' built-in configuration:
-- language-neutral (customer documents are not all English, and identifiers such as
-- max_payment_retries must not be stemmed), deterministic, and part of Postgres, so it adds nothing
-- to ADR 0004's extension list (T005). The heading path is searchable with the body.
-- Declared IMMUTABLE so a generated column may call it: `array_to_string` is only STABLE in the
-- catalogue (it dispatches on the element type's output function), but for text[] it is
-- deterministic, and to_tsvector(regconfig, text) is immutable.
CREATE FUNCTION "knowledge"."section_search_vector"(heading_path text[], content text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT to_tsvector('simple', coalesce(array_to_string(heading_path, ' '), '') || ' ' || content) $$;

-- CreateEnum
CREATE TYPE "knowledge"."knowledge_source_kind" AS ENUM ('repository_markdown', 'git_history', 'merge_request', 'ticket', 'incident_history', 'openapi', 'test_names', 'runbook', 'postmortem', 'hosted_wiki');

-- CreateEnum
CREATE TYPE "knowledge"."knowledge_connection_state" AS ENUM ('connected', 'disconnected', 'error');

-- CreateEnum
CREATE TYPE "knowledge"."knowledge_sync_state" AS ENUM ('idle', 'syncing', 'failed');

-- CreateEnum
CREATE TYPE "knowledge"."knowledge_document_class" AS ENUM ('expectation', 'runbook', 'postmortem', 'design_doc', 'readme', 'ticket', 'merge_request', 'api_description', 'test_manifest');

-- CreateEnum
CREATE TYPE "knowledge"."knowledge_provenance" AS ENUM ('human_authored', 'machine_generated', 'machine_generated_adopted');

-- CreateEnum
CREATE TYPE "knowledge"."expectation_provenance" AS ENUM ('human_authored', 'machine_generated');

-- CreateEnum
CREATE TYPE "knowledge"."knowledge_availability" AS ENUM ('available', 'unavailable', 'deleted_at_source');

-- CreateEnum
CREATE TYPE "knowledge"."expected_behavior_state" AS ENUM ('draft', 'adopted', 'superseded', 'retired');

-- CreateEnum
CREATE TYPE "knowledge"."duplicate_method" AS ENUM ('content_hash', 'trigram');

-- CreateEnum
CREATE TYPE "knowledge"."adoption_actor_type" AS ENUM ('human');

-- CreateEnum
CREATE TYPE "knowledge"."constraint_scope_kind" AS ENUM ('feature', 'component', 'expected_behavior');

-- CreateEnum
CREATE TYPE "knowledge"."constraint_value_type" AS ENUM ('int', 'decimal', 'bool', 'duration', 'string', 'enum');

-- CreateTable
CREATE TABLE "knowledge"."knowledge_source" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "knowledge"."knowledge_source_kind" NOT NULL,
    "adapter_key" TEXT NOT NULL,
    "connection_state" "knowledge"."knowledge_connection_state" NOT NULL,
    "sync_state" "knowledge"."knowledge_sync_state" NOT NULL,
    "last_successful_sync_at" TIMESTAMPTZ(6),
    "document_classes" TEXT[],
    "implemented" BOOLEAN NOT NULL,

    CONSTRAINT "knowledge_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge"."knowledge_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_ref" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "document_class" "knowledge"."knowledge_document_class" NOT NULL,
    "provenance" "knowledge"."knowledge_provenance" NOT NULL,
    "current_version_id" UUID NOT NULL,
    "duplicate_group_id" UUID,
    "component_node_id" UUID,
    "availability" "knowledge"."knowledge_availability" NOT NULL,
    "source_modified_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "owner_ref" TEXT,

    CONSTRAINT "knowledge_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge"."document_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "source_modified_at" TIMESTAMPTZ(6),
    "author_ref" TEXT,
    "commit_sha" TEXT,
    "supersedes_id" UUID,

    CONSTRAINT "document_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge"."document_section" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "heading_path" TEXT[],
    "content" TEXT NOT NULL,
    "char_start" INTEGER NOT NULL,
    "char_end" INTEGER NOT NULL,
    -- Generated, never written; the definition lives in knowledge.section_search_vector.
    "search_vector" tsvector GENERATED ALWAYS AS (
        knowledge.section_search_vector("heading_path", "content")
    ) STORED,

    CONSTRAINT "document_section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge"."duplicate_group" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "canonical_document_id" UUID NOT NULL,
    "method" "knowledge"."duplicate_method" NOT NULL,
    "threshold" DECIMAL(5,4) NOT NULL,
    "detected_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "duplicate_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge"."expected_behavior" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stable_key" TEXT NOT NULL,
    "feature_node_id" UUID,
    "component_node_id" UUID,
    "state" "knowledge"."expected_behavior_state" NOT NULL,
    "current_version_id" UUID NOT NULL,
    "seeding_session_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "expected_behavior_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge"."expected_behavior_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "expected_behavior_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "document_version_id" UUID NOT NULL,
    "provenance" "knowledge"."expectation_provenance" NOT NULL,
    "extraction_key" TEXT,
    "extraction_rule" TEXT,
    "source_artifact_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "expected_behavior_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge"."anchor_grant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "expected_behavior_version_id" UUID NOT NULL,
    "adoption_record_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "revocation_reason" TEXT,

    CONSTRAINT "anchor_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge"."adoption_record" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "expected_behavior_version_id" UUID NOT NULL,
    "actor_type" "knowledge"."adoption_actor_type" NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "approval_ref" TEXT,
    "merge_commit_sha" TEXT,
    "seeded_from" JSONB NOT NULL,
    "adopted_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "adoption_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge"."knowledge_constraint" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope_kind" "knowledge"."constraint_scope_kind" NOT NULL,
    "scope_ref" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "value_type" "knowledge"."constraint_value_type" NOT NULL,
    "value_json" JSONB NOT NULL,
    "document_version_id" UUID NOT NULL,
    "provenance" "knowledge"."knowledge_provenance" NOT NULL,
    "anchor_grant_id" UUID,

    CONSTRAINT "knowledge_constraint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_source_tenant_id_kind_idx" ON "knowledge"."knowledge_source"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_source_id_tenant_id_key" ON "knowledge"."knowledge_source"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "knowledge_document_tenant_id_document_class_idx" ON "knowledge"."knowledge_document"("tenant_id", "document_class");

-- CreateIndex
CREATE INDEX "knowledge_document_tenant_id_component_node_id_idx" ON "knowledge"."knowledge_document"("tenant_id", "component_node_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_document_id_tenant_id_key" ON "knowledge"."knowledge_document"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_document_tenant_id_source_id_external_ref_key" ON "knowledge"."knowledge_document"("tenant_id", "source_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "document_version_id_tenant_id_key" ON "knowledge"."document_version"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_version_tenant_id_document_id_version_no_key" ON "knowledge"."document_version"("tenant_id", "document_id", "version_no");

-- CreateIndex
CREATE INDEX "document_section_search_vector_idx" ON "knowledge"."document_section" USING GIN ("search_vector");

-- CreateIndex
CREATE UNIQUE INDEX "document_section_id_tenant_id_key" ON "knowledge"."document_section"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_section_tenant_id_document_version_id_ordinal_key" ON "knowledge"."document_section"("tenant_id", "document_version_id", "ordinal");

-- CreateIndex
CREATE INDEX "duplicate_group_tenant_id_canonical_document_id_idx" ON "knowledge"."duplicate_group"("tenant_id", "canonical_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_group_id_tenant_id_key" ON "knowledge"."duplicate_group"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "expected_behavior_id_tenant_id_key" ON "knowledge"."expected_behavior"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "expected_behavior_tenant_id_stable_key_key" ON "knowledge"."expected_behavior"("tenant_id", "stable_key");

-- CreateIndex
CREATE UNIQUE INDEX "expected_behavior_version_id_tenant_id_key" ON "knowledge"."expected_behavior_version"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "expected_behavior_version_tenant_id_expected_behavior_id_ve_key" ON "knowledge"."expected_behavior_version"("tenant_id", "expected_behavior_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "anchor_grant_expected_behavior_version_id_key" ON "knowledge"."anchor_grant"("expected_behavior_version_id");

-- CreateIndex
CREATE INDEX "anchor_grant_tenant_id_revoked_at_idx" ON "knowledge"."anchor_grant"("tenant_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "anchor_grant_id_tenant_id_key" ON "knowledge"."anchor_grant"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "anchor_grant_expected_behavior_version_id_tenant_id_key" ON "knowledge"."anchor_grant"("expected_behavior_version_id", "tenant_id");

-- CreateIndex
CREATE INDEX "adoption_record_tenant_id_expected_behavior_version_id_idx" ON "knowledge"."adoption_record"("tenant_id", "expected_behavior_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "adoption_record_id_tenant_id_key" ON "knowledge"."adoption_record"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "adoption_record_id_expected_behavior_version_id_tenant_id_key" ON "knowledge"."adoption_record"("id", "expected_behavior_version_id", "tenant_id");

-- CreateIndex
CREATE INDEX "knowledge_constraint_tenant_id_scope_kind_scope_ref_name_idx" ON "knowledge"."knowledge_constraint"("tenant_id", "scope_kind", "scope_ref", "name");

-- AddForeignKey
ALTER TABLE "knowledge"."knowledge_document" ADD CONSTRAINT "knowledge_document_source_id_tenant_id_fkey" FOREIGN KEY ("source_id", "tenant_id") REFERENCES "knowledge"."knowledge_source"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."knowledge_document" ADD CONSTRAINT "knowledge_document_current_version_id_tenant_id_fkey" FOREIGN KEY ("current_version_id", "tenant_id") REFERENCES "knowledge"."document_version"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "knowledge"."knowledge_document" ADD CONSTRAINT "knowledge_document_duplicate_group_id_tenant_id_fkey" FOREIGN KEY ("duplicate_group_id", "tenant_id") REFERENCES "knowledge"."duplicate_group"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."document_version" ADD CONSTRAINT "document_version_document_id_tenant_id_fkey" FOREIGN KEY ("document_id", "tenant_id") REFERENCES "knowledge"."knowledge_document"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."document_version" ADD CONSTRAINT "document_version_supersedes_id_tenant_id_fkey" FOREIGN KEY ("supersedes_id", "tenant_id") REFERENCES "knowledge"."document_version"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."document_section" ADD CONSTRAINT "document_section_document_version_id_tenant_id_fkey" FOREIGN KEY ("document_version_id", "tenant_id") REFERENCES "knowledge"."document_version"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."duplicate_group" ADD CONSTRAINT "duplicate_group_canonical_document_id_tenant_id_fkey" FOREIGN KEY ("canonical_document_id", "tenant_id") REFERENCES "knowledge"."knowledge_document"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."expected_behavior" ADD CONSTRAINT "expected_behavior_current_version_id_tenant_id_fkey" FOREIGN KEY ("current_version_id", "tenant_id") REFERENCES "knowledge"."expected_behavior_version"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "knowledge"."expected_behavior_version" ADD CONSTRAINT "expected_behavior_version_expected_behavior_id_tenant_id_fkey" FOREIGN KEY ("expected_behavior_id", "tenant_id") REFERENCES "knowledge"."expected_behavior"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."expected_behavior_version" ADD CONSTRAINT "expected_behavior_version_document_version_id_tenant_id_fkey" FOREIGN KEY ("document_version_id", "tenant_id") REFERENCES "knowledge"."document_version"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."anchor_grant" ADD CONSTRAINT "anchor_grant_expected_behavior_version_id_tenant_id_fkey" FOREIGN KEY ("expected_behavior_version_id", "tenant_id") REFERENCES "knowledge"."expected_behavior_version"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."anchor_grant" ADD CONSTRAINT "anchor_grant_adoption_record_id_expected_behavior_version__fkey" FOREIGN KEY ("adoption_record_id", "expected_behavior_version_id", "tenant_id") REFERENCES "knowledge"."adoption_record"("id", "expected_behavior_version_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."adoption_record" ADD CONSTRAINT "adoption_record_expected_behavior_version_id_tenant_id_fkey" FOREIGN KEY ("expected_behavior_version_id", "tenant_id") REFERENCES "knowledge"."expected_behavior_version"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."knowledge_constraint" ADD CONSTRAINT "knowledge_constraint_document_version_id_tenant_id_fkey" FOREIGN KEY ("document_version_id", "tenant_id") REFERENCES "knowledge"."document_version"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge"."knowledge_constraint" ADD CONSTRAINT "knowledge_constraint_anchor_grant_id_tenant_id_fkey" FOREIGN KEY ("anchor_grant_id", "tenant_id") REFERENCES "knowledge"."anchor_grant"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint
-- C-06: `hosted_wiki` is declared and ships unimplemented. The flag cannot be flipped to true for a
-- kind that has no adapter — the gap stays visible until a migration removes this CHECK together
-- with the adapter that closes it. There is deliberately no default on `implemented`: a source row
-- states it. `hosted_wiki` rows are tenant-scoped, so they are created per tenant by the onboarding
-- path with `implemented = false`, not seeded here.
ALTER TABLE "knowledge"."knowledge_source" ADD CONSTRAINT "knowledge_source_hosted_wiki_unimplemented_check"
  CHECK (kind <> 'hosted_wiki' OR implemented = false);

-- CheckConstraint
ALTER TABLE "knowledge"."document_section" ADD CONSTRAINT "document_section_char_range_check"
  CHECK (char_end >= char_start AND char_start >= 0);

-- CheckConstraint
-- Revocation is ONE record (FR-013): the three columns are all set or all NULL, never partial, and
-- the owner and reason are not blank. Set-once is enforced by the trigger in the next migration.
ALTER TABLE "knowledge"."anchor_grant" ADD CONSTRAINT "anchor_grant_revoked_by_check"
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL));
ALTER TABLE "knowledge"."anchor_grant" ADD CONSTRAINT "anchor_grant_revocation_reason_check"
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL));
ALTER TABLE "knowledge"."anchor_grant" ADD CONSTRAINT "anchor_grant_revocation_not_blank_check"
  CHECK (revoked_at IS NULL OR (btrim(revoked_by) <> '' AND btrim(revocation_reason) <> ''));

-- CheckConstraint
-- Human adoption only (FR-010, SC-001). `actor_ref` must name someone. That the named approver is
-- not Healer's own service identity cannot be a static CHECK: the identity is configuration
-- (research R-17), so that half is the adoption command's check (T026), not the database's.
ALTER TABLE "knowledge"."adoption_record" ADD CONSTRAINT "adoption_record_actor_type_human_check"
  CHECK (actor_type = 'human');
ALTER TABLE "knowledge"."adoption_record" ADD CONSTRAINT "adoption_record_actor_ref_not_blank_check"
  CHECK (btrim(actor_ref) <> '');

-- CheckConstraint
-- FR-008: an anchored (authoritative) constraint has a human or adopted provenance.
ALTER TABLE "knowledge"."knowledge_constraint" ADD CONSTRAINT "knowledge_constraint_anchored_provenance_check"
  CHECK (anchor_grant_id IS NULL OR provenance IN ('human_authored', 'machine_generated_adopted'));
