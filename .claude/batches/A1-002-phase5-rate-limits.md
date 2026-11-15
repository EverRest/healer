# A1 — 002 phase 5, catalogue-independent part (start now)

Status: launched 2026-10-11 as a background Opus orchestrator; not finished (see session). Use this file to re-run or hand over.

## 1. What and where
Repo `/Users/pavlo/code/healer`, spec `specs/002-policy-and-autonomy`, tasks **T054, T055, T085**, plus **T084** if `specs/010-safe-remediation/contracts/action-catalogue.md` is enough to test against. Delivers rate-limit, cooldown and attempt-cap predicates over `policy_decision` history, with `action_limit` as the single store (FR-014), bounds per `(tenant, action_key)`.

Do NOT touch these active sessions:
- `003-context-phase4`: `evidence/record-evidence.ts`, `schema.prisma`, migrations `20261005*`.
- `004-phase6-7-blast-radius-drift`: `packages/domain/architecture`.
- `final-005b` (005 phases 1-2): `packages/domain/knowledge`, `packages/integrations`, migrations `20261006*`.
- `worktree-012-inference-capability`: `packages/domain/policy` (6 files), `boundary-contract`, `apps/runner`, migration `20261008*`.
- `worktree-012-tenant-schedule`: `packages/workflow`, `apps/worker`.

## 4. Scope boundary
Build: T054, T055, T085, T084 if feasible. First confirm T054 and T085 do not read 010's catalogue; if they do, stop and report.
Do NOT start: T048-T053 (catalogue-derived reversibility, verification-window undo), T082, T058b, T066b.
Shared file: `packages/domain/policy` is also touched by 012-inference-capability. `git fetch` and diff `origin/master` for it before each sub-batch. New code in new sibling files; edits to shared index/exports are append-only.

## 9. Migration
`20261009000000_action_limit` with `down.sql`. Re-run `ls prisma/migrations` after fetch; bump if taken. Update 002 `data-model.md` in the same commit.

## Design notes from the first run (accepted)
- `policy.action_limit` table already exists (migration 20261001000000_policy_core); nothing supplies bounds today, so FR-014 is not enforced.
- Resolver overwrites the whole `DecisionInput.cooldown` group; add `secondsSinceLastAllow` and `bounds {ratePerWindow, cooldownSeconds, attemptCap}`; store bounds in `decision_input` (C-82).
- Count `outcome='allow' AND (consumed_at IS NOT NULL OR invalidated_reason IS NULL)`.
- Default bounds only for `reversible_remediation` actions without a row: one exported constant `DEFAULT_REMEDIATION_ACTION_LIMIT` (rate 1/3600 s, cooldown 3600 s, cap 3), marked `// PLACEHOLDER (stage-0)`. Record in QUESTIONS.md; "pick real bounds" goes to the Pavlo index.
- Per-scope advisory lock with bounded wait (ADR 0015 pattern) instead of FOR UPDATE, because no row is guaranteed. `ActionLimitContentionError` on timeout.
- T084: add 6 keys to `SEED_POLICY_ACTIONS` and `db-seed.mjs`; contract test parses catalogue headings both ways, fails on zero keys; fix `ATTEMPT_CAP` vs `ATTEMPT_CAP_REACHED` spelling.

## Shared block (2, 3, 5-8, 10-12)
See `_shared-block.md`.
