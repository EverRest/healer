-- DropIndex
DROP INDEX IF EXISTS "events"."outbox_claim_idx";

-- DropColumn
ALTER TABLE "events"."outbox" DROP COLUMN IF EXISTS "claimed_at";
