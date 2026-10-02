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
--
-- Review fix: `evidence.evidence` carries the `evidence_append_only` trigger
-- (`reject_evidence_mutation()`, 20260927000000_issue_evidence_audit) on every UPDATE/DELETE —
-- this bare DELETE raised on any database that actually held a discovery evidence row (the
-- round-trip test only ever passed because it runs against an empty database;
-- discovery-evidence-migration-down.e2e.test.ts now seeds one first). `SET LOCAL` (never bare
-- `SET` — see that trigger's own comment on pooled-connection leakage), scoped to this transaction
-- only; psql's `-c` with multiple `;`-separated statements runs them as one implicit transaction,
-- so this setting is still in force for the DELETE below.
--
-- This DELETE does not logically clean up: `graph_node.observation_ref` / `edge_provenance.
-- observation_ref` / `draft_item.observation_ref` are not foreign keys into this table (by design
-- — see data-model.md), so a reverse migration run against a database that still has architecture
-- rows pointing at the deleted evidence leaves those `observation_ref`s dangling. Acceptable only
-- because reversing this migration is already documented above as discarding discovery evidence;
-- a reverse this deep into a populated graph is a disaster-recovery action, not a routine one.
SET LOCAL healer.privileged_write = 'on';
DELETE FROM "evidence"."evidence" WHERE "issue_id" IS NULL;

-- AlterTable
ALTER TABLE "evidence"."evidence" ALTER COLUMN "issue_id" SET NOT NULL;
