# A3 — 005 phases 3-4 (start only after `final-005b` is merged to master)

## 1. What and where
Spec `specs/005-knowledge-and-expected-behavior`.
- Phase 3 (US1): T022-T042. Only an adopted expectation is an anchor.
- Phase 4 (US2): T043-T053. The stale wiki cannot cause a misdiagnosis.

Precondition: `final-005b` (005 phases 1-2, T001-T021) is on master, with migrations `20261006000000_knowledge_core`, `20261006010000_knowledge_append_only_rules`, `20261006020000_knowledge_section_embedding`. If not, stop and report.

Do NOT touch: 003 phase 4-7 work; `004-phase6-7-blast-radius-drift`; `worktree-012-inference-capability`; `worktree-012-tenant-schedule`.

## 4. Scope boundary
Build: phases 3-4. T017 (repository markdown ingest) is already in phases 1-2; build on it.
Do NOT start: phase 5 (US3 retrieval; T011 tenant-partitioned embeddings is its prerequisite); phases 6-8 (phase 8 needs T025/T026 `anchor_grant` and `adoption_record`; phase 6 needs 004 phases 5 and 8).
Constraints:
- T025 and T026 are in phase 3. The human-only `adoption_record` is the only path to an anchor. Nothing machine-generated becomes an `ExpectedBehavior`.
- T024 and T055 are contract-review assertions run against the generated OpenAPI.
Shared files: `packages/domain/knowledge`, `packages/integrations`. Fetch first.

## 9. Migration
Only if a task needs one: `20261011000000_<name>` with `down.sql`, after confirming it is free. Update `data-model.md` in the same commit.

## Shared block (2, 3, 5-8, 10-12)
See `_shared-block.md`.
