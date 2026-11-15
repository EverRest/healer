You are the orchestrator of batch B2 in the repository /Users/pavlo/code/healer. This is the prompt for a separate session. Work alone. Do not ask questions during the work.

# B2 — 011 simulator-and-eval, phases 1–3 (the eval foundation and "a simulation cannot touch production")

First, read these files completely: `.claude/batches/_shared-block.md` and `.claude/batches/B-plan.md`.
The "Overrides" section of `B-plan.md` has priority over `_shared-block.md`. It requires:
- one worktree for the batch and one for each sub-batch;
- TDD with `superpowers:test-driven-development`;
- a final review with `superpowers:requesting-code-review`;
- no merge, no push and no `Co-Authored-By` trailer without the word of Pavlo.

## Scope
Spec `specs/011-simulator-and-eval`: **T001–T022** (Phase 1 Setup, Phase 2 Foundational, Phase 3 US2).

You own only these paths:
- `packages/domain/evaluation/**`
- `packages/shared/capabilities/**` (a new directory)
- `specs/011-simulator-and-eval/**`
- migrations `prisma/migrations/20261030*` (each with a `down.sql`)
- your block `// ── B2 ──` in `prisma/schema.prisma`
- lines in `apps/api/src/main.ts` under the comment `// B2`

Do not touch these paths:
- `packages/domain/{policy,architecture,knowledge,remediation,reproduction}/**`
- `apps/runner/**`
- `packages/boundary-contract/**` (new files only, plus one export line)
- `packages/llm/**` (batch B4 owns it)

## Precondition
None. Start now. First, read the Dependencies section of `plan.md` and `tasks.md`. Make sure that T001–T022 do not read 006, 009 or 010. Those features are not built yet. If a task reads them, skip it. Record it in a new `QUESTIONS.md` section "B2 — 011 phases 1–3". Then continue.

## Invariants
- Each golden-dataset entry has `split ∈ dev · benchmark`. The field is mandatory. Nobody updates it (C-29).
- Only a `benchmark` run without synthetic entries can derive an autonomy threshold (C-30, ADR 0009).
- Do not invent thresholds. The numbers stay "deliberately unset".

## Order of work
1. Do the setup from `_shared-block.md` §2 in the worktree `b2-011-eval-foundation`.
2. Read the spec, plan, research, data-model, quickstart, tasks and contracts of 011. Read ADR 0009, `docs/runbooks/raising-autonomy.md` and S0-2/S0-3 in `docs/stage-0.md`.
3. Write the exact list of files for each sub-batch. If two sub-batches use the same file, do them one after the other.
4. Implement with TDD. Mutation-check each guard. Add a tenant-isolation e2e test for each endpoint. Update `data-model.md` with each schema change.
5. At the end, run `make ci` in the worktree. Run `superpowers:requesting-code-review` against `origin/master`. Fix each Critical and Important finding. Then run `superpowers:verification-before-completion`.
6. Tick the finished tasks in `tasks.md`. Write the final report as `_shared-block.md` §12 requires. Add a list of the files that you touched outside your ownership.
