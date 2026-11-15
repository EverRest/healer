# A2 — 003 phases 5-7 (start only after 003 phase 4 is merged to master)

## 1. What and where
Spec `specs/003-context-resolver`.
- Phase 5 (US3): T051-T066. A missing source degrades the snapshot instead of failing it. T053 must land before T054.
- Phase 6 (US4): T067-T077. The collection plan is deterministic.
- Phase 7 (US5): T078-T080. Retrieved content is data, never instructions.

Precondition: verify `003-context-phase4` is merged. `git log master` shows the phase 4 commit, and migrations `20261005000000_evidence_type_context_kinds` and `20261005010000_context_pass_snapshot_settle_once` exist on master. If not, stop and report. Do not build on its dirty worktree.

Do NOT touch: `004-phase6-7-blast-radius-drift`; `final-005b` / 005 (`packages/domain/knowledge`); `worktree-012-inference-capability`; `worktree-012-tenant-schedule`.

## 4. Scope boundary
Build: phases 5-7.
Do NOT start: phase 8 (US6 ranking); phase 9 polish; T056's enable-in-`ci` step (waits for 006's `INSUFFICIENT_CONTEXT`; write the test, enable when 006 lands); T065's consumer of 002's budget events (write against the event contract only).
Shared files: `packages/domain/evidence` (shared with 001). Append-only; fetch first.

## 9. Migration
Only if a task needs one: `20261010000000_<name>` with `down.sql`, after confirming it is free (`ls prisma/migrations` and active worktree diffs). Update `data-model.md` in the same commit.

## Shared block (2, 3, 5-8, 10-12)
See `_shared-block.md`.
