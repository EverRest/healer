You are the orchestrator of batch B3 in the repository /Users/pavlo/code/healer. This is the prompt for a separate session. Work alone. Do not ask questions during the work.

# B3 — 007 reproduction-and-sandbox, phases 1, 2 and 6 (a sandbox that is hostile to the code that runs in it)

First, read these files completely: `.claude/batches/_shared-block.md` and `.claude/batches/B-plan.md`.
The "Overrides" section of `B-plan.md` has priority over `_shared-block.md`. It requires:
- one worktree for the batch and one for each sub-batch;
- TDD with `superpowers:test-driven-development`;
- a final review with `superpowers:requesting-code-review`;
- no merge, no push and no `Co-Authored-By` trailer without the word of Pavlo.

## Scope
Spec `specs/007-reproduction-and-sandbox`: **T001–T017** (Phase 1 Setup, Phase 2 Foundational) and **T055–T076** (Phase 6 US4 — the sandbox is hostile).

You own only these paths:
- `packages/sandbox/**`
- `packages/domain/reproduction/**`
- `specs/007-reproduction-and-sandbox/**`
- migrations `prisma/migrations/20261040*` (each with a `down.sql`)
- your block `// ── B3 ──` in `prisma/schema.prisma`

Do not touch these paths:
- `apps/runner/**`. The worktree `worktree-012-inference-capability` uses it. If a task needs the runner, skip it. Record it in a new `QUESTIONS.md` section "B3 — 007 phases 1–2, 6".
- `packages/domain/{policy,architecture,knowledge,remediation,evaluation}/**`
- `packages/boundary-contract/**` (new files only, plus one export line)
- `packages/llm/**`

## Precondition
None. Start now. Phases 3–5, 7–9 and 12 are not in this batch. They contain the reproduction ladder. They wait for 006. They are in batch B14.

## Invariants
- The sandbox denies egress by default. It holds no production credentials. No agent gets a raw shell (`.claude/rules/security-and-tenancy.md`).
- A test must prove each safety claim. The test tries to get out: egress, mounted secrets, host paths. A comment is not proof.
- Each guarantee names a reader. The reader is a mechanism that refuses to continue without the guarantee.

## Order of work
1. Do the setup from `_shared-block.md` §2 in the worktree `b3-007-sandbox`.
2. Read the spec, plan, research, data-model, quickstart, tasks and contracts of 007. Read ADR 0001, 0008 and 0010, `docs/security-posture.md` and `docs/runbooks/runner-diagnosis.md`.
3. Write the exact list of files for each sub-batch. If two sub-batches use the same file, do them one after the other. Do not run `docker prune` on the shared daemon. Remove only your own containers.
4. Implement with TDD. Mutation-check each guard. Update `data-model.md` with each schema change.
5. At the end, run `make ci` in the worktree. Run `superpowers:requesting-code-review` against `origin/master`. Fix each Critical and Important finding. Then run `superpowers:verification-before-completion`.
6. Tick the finished tasks in `tasks.md`. Write the final report as `_shared-block.md` §12 requires. Add a list of the files that you touched outside your ownership.
