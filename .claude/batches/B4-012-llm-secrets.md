You are the orchestrator of batch B4 in the repository /Users/pavlo/code/healer. This is the prompt for a separate session. Work alone. Do not ask questions during the work.

# B4 — 012 LLM interface, secrets and the provider for each tenant (T066, T067, T068, T095)

First, read these files completely: `.claude/batches/_shared-block.md` and `.claude/batches/B-plan.md`.
The "Overrides" section of `B-plan.md` has priority over `_shared-block.md`. It requires:
- one worktree for the batch and one for each sub-batch;
- TDD with `superpowers:test-driven-development`;
- a final review with `superpowers:requesting-code-review`;
- no merge, no push and no `Co-Authored-By` trailer without the word of Pavlo.

## Scope
Spec `specs/012-engineering-foundation`: **T066, T067, T068, T095**. Today, `tasks.md` and `QUESTIONS.md` mark all four as `deferred`. The `LLM` interface does not exist, and nobody chose a secret manager.

You own only these paths:
- `packages/llm/**`
- `packages/prompts/**`
- `packages/shared/config/**`
- `docs/adr/0020-*` (a new ADR; 0019 is taken by the OIDC ADR)
- `docs/runbooks/provider-key-rotation.md`
- one line in the index `docs/README.md`

This batch has no migrations.

Do not touch these paths:
- `packages/workflow/**`, `apps/worker/**`, `apps/runner/**`, `packages/boundary-contract/**` (the active session `012-inference-capability` uses them)
- `packages/domain/**`

## Precondition
Decided by Pavlo on 2026-11-15, overriding the earlier "start now":

- **T067 and T068 wait** for a real build (010's or a dedicated 012 slice), as QUESTIONS.md says. Do not write the `LLM` adapter or the resolver in this batch until Pavlo gives the go-ahead.
- **Now:** write **ADR 0020** (status Proposed; 0019 is taken) and the docs. It covers the secret source and the provider SDK behind the `LLM` interface. List the options and the rejected options. Add no dependency. The `SecretResolver` port reads a reference through `shared/config`, with no cloud SDK. Put the choice of a real secret manager and of the first provider SDK in "Decisions waiting on Pavlo".
- The tenant reference type (`TenantRef`: id and provider kind) goes in `packages/shared`, not in `packages/domain/**`.

## Invariants

- Use provider SDKs only behind the `LLM` interface and only in `llm/*/infrastructure` (lint rule).
- Provider configuration is per tenant. Never use a process-global client (ADR 0006, FR-045).
- If the provider of a BYO tenant fails, the system must not fall back to a provider of Healer. The work fails and retries (FR-046, SC-016). Write this test first (T068).
- Configuration holds references to secrets. It never holds values. Put no secret in a log.

## Order of work

1. Do the setup from `_shared-block.md` §2 in the worktree `b4-012-llm-secrets`.
2. Read the spec, plan and research of 012 (FR-042, FR-045, FR-046), ADR 0006, `.claude/rules/agents-and-llm.md` and the sections of `QUESTIONS.md` about T066–T068.
3. Write ADR 0020 and the docs first (Precondition above). Then **stop and report to Pavlo**. Do not start T068/T067 without his go-ahead.
4. After the go-ahead, implement with TDD in this order: T068 (red), then the `LLM` interface and the resolver for each tenant (T067), then the secrets port (T066), then the runbook (T095).
5. Mutation-check: remove the rule "a BYO tenant never uses the provider of Healer". Make sure that the test fails.
6. At the end, run `make ci` in the worktree. Run `superpowers:requesting-code-review` against `origin/master`. Fix each Critical and Important finding. Then run `superpowers:verification-before-completion`.
7. Do not edit `tasks.md` or `QUESTIONS.md`. The integrator ticks tasks and removes `deferred` marks after merge. Write the final report as `_shared-block.md` §12 requires, and list the tasks that are ready to tick.
