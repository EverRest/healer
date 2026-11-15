You are the orchestrator of batch B5 in the repository /Users/pavlo/code/healer. This is the prompt for a separate session. Work alone. Do not ask questions during the work.

# B5 — 012 US10, the repository part of agent-driven development (T088, T089, T091, T092, T099, T100, T104)

First, read these files completely: `.claude/batches/_shared-block.md` and `.claude/batches/B-plan.md`.
The "Overrides" section of `B-plan.md` has priority over `_shared-block.md`. It requires:
- one worktree for the batch and one for each sub-batch;
- TDD with `superpowers:test-driven-development`;
- a final review with `superpowers:requesting-code-review`;
- no merge, no push and no `Co-Authored-By` trailer without the word of Pavlo.

## Scope
Spec `specs/012-engineering-foundation`: **T088, T089, T091, T092, T099, T100, T104**. Also check that `.github/workflows/ci.yml` runs exactly `make ci`.

You own only these paths:
- `.github/PULL_REQUEST_TEMPLATE/**`
- `.github/workflows/agent-task.yml`
- `.github/workflows/ruleset-drift.yml`
- `scripts/agent/**` (a new directory: the ready-task selection of T099 and the follow-up logic of T100)
- `docs/runbooks/chat-channel.md`
- `AGENTS.md` (only a new section "working as an automated agent", T091)
- the index `docs/README.md`

This batch has no migrations.

Do not touch these paths:
- `scripts/checks/**` and `scripts/gates/**`. You can add a new file there only if a gate needs it.
- `packages/**` and `apps/**`.

## What you must NOT do (a human must act or agree)
- T090 (the branch ruleset and a `CODEOWNERS` file with real people).
- Installing the GitHub App.
- Any change to the live repository `github.com:EverRest/healer`, and any token or secret.

Write the workflow files and test them locally. Do not apply anything to GitHub. You can prepare the wanted ruleset settings as data. Use them only as a fixture for the test of T092. Mark them "not applied".
T097, T098 and T101–T103 are also outside this batch. They need a Telegram token, the choice of an agent, and a bridge to 008.

## Invariants
- An agent pull request holds one task. The App never merges and never approves (FR-053..FR-059).
- T099: write the test first. Use a fixture `tasks.md` with one blocked task, one ready task and one in-flight task. The rule for "ready" is deterministic.
- T092: write the test first, with a fixture ruleset that has no code-owner rule.
- Do not go deep into the Telegram intake. ADR 0016 has the status Proposed.

## Order of work
1. Do the setup from `_shared-block.md` §2 in the worktree `b5-012-agent-tooling`.
2. Read US10 in the spec, plan and research of 012 (R-16), ADR 0011 and 0016, `.claude/rules/00-core.md`, `scripts/gates/gate-agent-scope*`, `gate-red-first*` and the sections of `QUESTIONS.md` about T099 and T100.
3. Implement with TDD: tests first (T099, T092, the gate for T088), then the code, then the documentation.
4. At the end, run `make ci` in the worktree. Run `superpowers:requesting-code-review` against `origin/master`. Fix each Critical and Important finding. Then run `superpowers:verification-before-completion`.
5. Tick the finished tasks in `tasks.md`. Write the final report as `_shared-block.md` §12 requires. Add one item that lists what a human must still do (T090, the GitHub App).

## Decisions (agreed with Pavlo, 2026-11-15)
- **T088:** a targeted edit of `scripts/gates/agent-scope.mjs` is allowed, only for the task-ID check, with its test. No other gate changes.
- **Ticks and judgment calls:** `specs/012-engineering-foundation/tasks.md` and a new `QUESTIONS.md` section for 012 are owned by this batch.
- **T089:** write the workflow with a placeholder step for the coding agent. Test TASK_ID, budget, concurrency and token handling without an agent. T097 stays open for Pavlo.
- **T099 and T100:** adopt the recommendations in `QUESTIONS.md` and record them as judgment calls.
- **Co-Authored-By:** none, until Pavlo says otherwise. This overrides the global CLAUDE.md for this batch.
- **Work mode:** follow `_shared-block.md` §5 and §8. Sonnet subagents implement in their own worktrees. Opus subagents run the two reviews. The orchestrator plans, dispatches and integrates.
