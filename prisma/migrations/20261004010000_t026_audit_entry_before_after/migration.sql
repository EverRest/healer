-- 004 T026 (FR-025, data-model.md): a graph mutation's audit entry carries "the before and after
-- payloads ... and the minted graph_version" — three columns the shared `audit.audit_entry` table
-- (001) did not have. Additive and nullable: every existing caller (001 issue transitions, 002
-- policy/autonomy) keeps writing rows with these three NULL, exactly as before. Same precedent as
-- 20261004000000_t018_t035's `evidence.issue_id` change — the table is 001's, 004 extends it,
-- documented in both packages' data-model.md.

-- AlterTable
ALTER TABLE "audit"."audit_entry" ADD COLUMN "before" JSONB;
ALTER TABLE "audit"."audit_entry" ADD COLUMN "after" JSONB;
ALTER TABLE "audit"."audit_entry" ADD COLUMN "graph_version" INTEGER;
