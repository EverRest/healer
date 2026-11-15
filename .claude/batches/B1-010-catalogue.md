You are the orchestrator of batch B1 in the repository /Users/pavlo/code/healer. This is the prompt for a separate session. Work alone. Do not ask questions during the work.

# B1 — 010 safe-remediation, phases 1–3 (the catalogue: "four declarations, or the action is not in the catalogue")

First, read these files completely: `.claude/batches/_shared-block.md` and `.claude/batches/B-plan.md`.
The "Overrides" section of `B-plan.md` has priority over `_shared-block.md`. It requires:
- one worktree for the batch and one for each sub-batch;
- TDD with `superpowers:test-driven-development`;
- a final review with `superpowers:requesting-code-review`;
- no merge, no push and no `Co-Authored-By` trailer without the word of Pavlo.

## Scope
Spec `specs/010-safe-remediation`: **T001–T033** (Phase 1 Setup, Phase 2 Foundational, Phase 3 US2 — the catalogue).

You own only these paths:
- `packages/domain/remediation/**`
- `specs/010-safe-remediation/**`
- migrations `prisma/migrations/20261020*` (each with a `down.sql`)
- your block `// ── B1 ──` at the end of the related schema in `prisma/schema.prisma`
- one or more lines in `apps/api/src/main.ts` under the comment `// B1`, if you need a controller

Do not touch these paths:
- `apps/runner/**`. The worktree `worktree-012-inference-capability` uses it. If a task needs the runner, skip it. Record it in a new `QUESTIONS.md` section "B1 — 010 phases 1–3".
- `packages/domain/policy/**`, `packages/domain/architecture/**`, `packages/domain/knowledge/**`.
- `packages/boundary-contract/**`. You can add new shapes only in new files, plus one export line.

## Precondition
None. Start now. Before you start, run `git fetch`. Run `ls prisma/migrations`. Make sure that the range `20261020*` is free.

## Why this batch exists
The catalogue of 010 unblocks 002 T048–T053 and T084. Batch A1 builds the rate-limit part of 002 now.
Do not change `specs/010-safe-remediation/contracts/action-catalogue.md` unless you must. A1 parses this file in a contract test.

## Order of work
1. Do the setup from `_shared-block.md` §2 in the worktree `b1-010-catalogue`.
2. Read the spec, plan, research, data-model, quickstart, tasks and contracts of 010. Read ADR 0008, ADR 0010 and `docs/patterns.md`.
3. Write the exact list of files for each sub-batch. If two sub-batches use the same file, do them one after the other. Run the other sub-batches in separate worktrees.
4. Implement with TDD: red, green, refactor. Mutation-check each guard. Add a tenant-isolation e2e test for each endpoint. Update `data-model.md` with each schema change.
5. At the end, run `make ci` in the worktree. Run `superpowers:requesting-code-review` against `origin/master`. Fix each Critical and Important finding. Then run `superpowers:verification-before-completion`.
6. Tick the finished tasks in `tasks.md`. Use a short note of facts, in the style of the file. Write the final report as `_shared-block.md` §12 requires. Add a list of the files that you touched outside your ownership.
