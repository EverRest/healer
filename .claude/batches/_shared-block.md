# Shared block — paste after the batch header (A1, A2, A3)

Written 2026-10-11. Model rule from Pavlo: Opus only for planning and the two code reviews. All coding (tests, implementation, migrations, review fixes, doc and tick edits, mechanical work) is done by Sonnet 5.5 subagents. The orchestrator plans, dispatches and integrates, and writes no code itself.

## 2. Setup
- `git pull --ff-only` in the main checkout.
- `EnterWorktree` with a distinct name (a subagent launched with `isolation: "worktree"` skips this and instead runs `git fetch` and rebases onto `origin/master`).
- Then, as separate plain commands: `pnpm install --frozen-lockfile`, `pnpm run db-generate`, `pnpm run typecheck`.

## 3. Read first
`CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`, `.specify/memory/constitution.md`; the spec's `spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `tasks.md`, `contracts/`; `docs/patterns.md`, `docs/decisions.md`, `docs/adr/`; `QUESTIONS.md` (index plus any section about this spec or a resource it shares with a neighbour).

## 5. Working method
Sub-batches through subagents in their own worktrees when tasks share no files. After each sub-batch run two independent reviews: `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter`, both with `model: 'opus'`. Send findings back to the same Sonnet implementer as one package to fix, then integrate. Implementers use `model: 'sonnet'`. Do not run docker prune commands against the shared daemon; scope cleanup to your own containers.

## 6. Rules
- TDD: watch each new test fail for the right reason before the code exists.
- Mutation-check every guard added or tightened; restore byte-for-byte.
- `tenantId` only from auth context.
- Make the unsafe state unrepresentable rather than checked.
- A new dependency or pattern needs an ADR first.
- Model confidence is never a gate.

## 7. Lessons from 001
- A READ COMMITTED read-then-write guard with no row lock fails silently under a real race. Prove races with a held-open transaction polled through `pg_stat_activity`, never `sleep`.
- Reuse the concurrency-error mapping in `packages/domain/issues/src/infrastructure/prisma-concurrency.ts`.
- Lint limit: 400 counted lines per file. Extract a sibling module before you hit it.
- e2e tests import the built `dist` of workspace packages: run `pnpm run typecheck` before every e2e run.
- A genuinely heavy e2e file goes into `HEAVY_E2E` in `vitest.config.ts`.
- The worktree shell refuses complex compound commands (`cd ../..`, `git -C`, shell variables in command position). Keep commands plain and separate.

## 8. Models
Opus 5.5: planning and both reviews. Sonnet 5.5: implementation, fixes, mechanical work.

## 10. Don't stall
Record judgment calls in a new `QUESTIONS.md` section named for the spec. Anything that needs Pavlo goes in the "Decisions waiting on Pavlo" index at the end. Never ask mid-task. Tick tasks in `tasks.md` with a short factual note, matching the existing style.

## 11. Git
- No `Co-Authored-By` trailer.
- At the end: full `make ci` green. Rerun any heavy e2e file alone if it failed under load, and say so plainly.
- Known-red: `apps/runner/runner-image.e2e.test.ts` (SIGTERM drain) fails on master too (`QUESTIONS.md` item 0). Report it as pre-existing.
- Then `git fetch`. If `origin/master` moved, rebase and re-verify.
- Push to master fast-forward only. If something is red and not explained by load, do not push; stop and describe it.

## 12. Final report
What was built; what was not and why; the `make ci` result; the commits landed on master; any file touched that another active session might also touch.
