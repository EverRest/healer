-- DropIndex
DROP INDEX IF EXISTS "events"."outbox_tenant_id_published_at_occurred_at_idx";

-- DropTable
DROP TABLE IF EXISTS "events"."outbox";

-- DropSchema
DROP SCHEMA IF EXISTS "events";
