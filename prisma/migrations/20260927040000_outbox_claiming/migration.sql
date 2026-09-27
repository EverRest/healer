-- Review finding on 001 T013's outbox: `claimUnpublished` was a plain, unlocked `findMany`, so
-- two concurrent drain workers (a real scenario — the outbox drain job scales the same way every
-- other queue class does) could both claim and publish the same batch. It also always ordered by
-- `occurred_at` alone, so a permanently-failing event at the head of the queue blocked every event
-- behind it forever — confirmed: 5 failed attempts on the oldest row, the next row never tried.
--
-- `claimed_at` plus `FOR UPDATE SKIP LOCKED` (in the application code that issues the claim query)
-- makes concurrent claims mutually exclusive without either worker blocking on the other; a claim
-- older than 5 minutes is treated as abandoned (a crashed worker) and becomes claimable again.
ALTER TABLE "events"."outbox" ADD COLUMN "claimed_at" TIMESTAMPTZ(6);

-- The original tenant_id-leading index stays: `outbox` is still a tenant-scoped table by every
-- other convention (prisma-migrations.md), even though the claim query itself is deliberately
-- tenant-agnostic (see `PrismaOutboxStore`'s doc comment) — a future tenant-scoped read (an audit
-- view over one tenant's events, say) still needs it, and the migration e2e suite's own
-- leading-tenant_id-index check enforces exactly this.
--
-- Added alongside it: a second, partial index matching the claim query's real shape — unpublished
-- rows, lowest-attempts-first, oldest-first. Partial on `published_at IS NULL` — a published row
-- never needs to be found by this index again.
CREATE INDEX "outbox_claim_idx" ON "events"."outbox"("attempts", "occurred_at")
  WHERE "published_at" IS NULL;
