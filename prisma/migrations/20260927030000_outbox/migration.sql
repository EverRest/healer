-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "events";

-- The transactional outbox (012 FR-031, consumed by 001 FR-014). 012 T012 built only the pure
-- logic (packages/events/src/outbox.ts); this table is its first real backing store (001 T013).
CREATE TABLE "events"."outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unpublished-first, oldest-first — exactly claimUnpublished's query shape.
CREATE INDEX "outbox_tenant_id_published_at_occurred_at_idx" ON "events"."outbox"("tenant_id", "published_at", "occurred_at");
