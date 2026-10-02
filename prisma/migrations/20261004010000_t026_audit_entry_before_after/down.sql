-- Purely additive forward side (three nullable columns) — dropping them loses no other table's
-- data and no existing caller ever wrote them, so this reversal is a plain drop, no SET LOCAL /
-- privileged-write dance needed (contrast 20261004000000_t018_t035's down.sql, which had to
-- delete rows before a NOT NULL could be restored).

-- AlterTable
ALTER TABLE "audit"."audit_entry" DROP COLUMN "graph_version";
ALTER TABLE "audit"."audit_entry" DROP COLUMN "after";
ALTER TABLE "audit"."audit_entry" DROP COLUMN "before";
