-- 004 Phase 3 (T018-T035): discovery evidence has no issue, and draft_item's three shape
-- guarantees move from "the application happens to write it this way" to a database constraint
-- (FR-027, R-07, mirrors graph_node's T006 CHECKs).

-- AlterTable
-- `evidence.evidence.issue_id` was NOT NULL (001) because every evidence row described an issue.
-- Discovery evidence (`graph_fact`, and the `collection_gap` rows a non-collected source produces,
-- 004 FR-023/FR-027) has none: a `graph_fact` is what the discovery step observed about the
-- architecture, not a claim about an issue. Dropping NOT NULL and adding the CHECK below is what
-- makes "no issue" representable for exactly those two types and nothing else.
ALTER TABLE "evidence"."evidence" ALTER COLUMN "issue_id" DROP NOT NULL;

-- CheckConstraint
ALTER TABLE "evidence"."evidence" ADD CONSTRAINT "evidence_issue_id_check"
  CHECK (issue_id IS NOT NULL OR type IN ('graph_fact', 'collection_gap'));

-- CheckConstraint
-- data-model.md draft_item: mirrors graph_node's T006 "every non-human class carries an
-- observation" CHECK — a draft item proposed by discovery (any provenance but the two human
-- classes) must name the graph_fact evidence row it came from (FR-027).
ALTER TABLE "architecture"."draft_item" ADD CONSTRAINT "draft_item_observation_ref_check"
  CHECK (provenance IN ('human_authored', 'human_confirmed') OR observation_ref IS NOT NULL);

-- CheckConstraint
-- A decision (confirmed/rejected) always names who decided it and when; a still-`proposed` or
-- `superseded` item never does — the two facts are the same fact seen from either side, so the
-- boolean equality makes the pair unrepresentable out of step (docs/patterns.md).
ALTER TABLE "architecture"."draft_item" ADD CONSTRAINT "draft_item_decision_check"
  CHECK ((state IN ('confirmed', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL));

-- CheckConstraint
-- `add_node`/`add_edge` have no target — there is nothing yet to point at. Every other op
-- (`modify_attributes`, `mark_removed`) names the node or edge row it targets. A confirmed
-- `add_*` item later records the row it created in `target_node_id`/`target_edge_id` (application
-- -level, on confirm — T026/T038) — that is how `check:confirmation-actors` walks from a confirmed
-- graph row back to its deciding human, but this CHECK only guarantees the op/target shape, not
-- the confirm-time backfill.
ALTER TABLE "architecture"."draft_item" ADD CONSTRAINT "draft_item_target_check"
  CHECK (op IN ('add_node', 'add_edge') OR target_node_id IS NOT NULL OR target_edge_id IS NOT NULL);
