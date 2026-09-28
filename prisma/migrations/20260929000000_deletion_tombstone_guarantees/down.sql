DROP TRIGGER IF EXISTS "deletion_tombstone_no_truncate" ON "audit"."deletion_tombstone";
DROP TRIGGER IF EXISTS "deletion_tombstone_immutable" ON "audit"."deletion_tombstone";
DROP FUNCTION IF EXISTS reject_tombstone_mutation();
ALTER TABLE "audit"."deletion_tombstone" DROP CONSTRAINT IF EXISTS "deletion_tombstone_reason_bounds";
ALTER TABLE "audit"."deletion_tombstone" DROP CONSTRAINT IF EXISTS "deletion_tombstone_requested_by_bounds";
DROP INDEX IF EXISTS "audit"."deletion_tombstone_tenant_id_target_type_target_id_key";
