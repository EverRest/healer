-- DropCheckConstraint
ALTER TABLE "architecture"."draft_item" DROP CONSTRAINT "draft_item_target_check";

-- DropCheckConstraint
ALTER TABLE "architecture"."draft_item" DROP CONSTRAINT "draft_item_decision_check";

-- DropCheckConstraint
ALTER TABLE "architecture"."draft_item" DROP CONSTRAINT "draft_item_observation_ref_check";

-- DropCheckConstraint
ALTER TABLE "evidence"."evidence" DROP CONSTRAINT "evidence_issue_id_check";

-- A row with issue_id NULL cannot satisfy a restored NOT NULL — delete the issue-less rows this
-- migration's forward side made representable (every one is a `graph_fact`/`collection_gap` row
-- with no issue) before reinstating the constraint. Reversing this migration therefore discards
-- discovery evidence; that is the deliberate, documented cost of a reverse migration on this
-- column, not an oversight.
DELETE FROM "evidence"."evidence" WHERE "issue_id" IS NULL;

-- AlterTable
ALTER TABLE "evidence"."evidence" ALTER COLUMN "issue_id" SET NOT NULL;
