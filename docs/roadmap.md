# Roadmap

## North Star

```text
Observe → Understand → Diagnose → Act → Verify → Learn → Document
```

A closed loop where evidence, policy and verification decide — not the model.

## Stage 0 — blockers

See [stage-0.md](stage-0.md). S0-1 (incident history audit) blocks realistic planning of v1.

## Stage 1 — specifications

All 12 `spec.md` written 2026-09-23: 340 functional requirements, 133 success criteria.
All 7 clarifications resolved 2026-09-24 (C-01..C-07 in [decisions.md](decisions.md)) — zero open.
All 12 spec sets complete and analyzed, 2026-09-24 — spec, plan, research, data-model, contracts,
quickstart and tasks. After the stage-0 review the same day: **366 functional requirements, 138 success
criteria, 1 166 tasks**, 235 research entries, 29 contract documents, 587 quickstart scenarios.
After 012 US10 (agent-driven development), ADR 0010 (inference follows the source), C-36..C-42 and
013 (regression suite, specified through tasks and analyzed), 2026-09-26: **13 specs, 399 functional
requirements, 148 success criteria, 1 221 tasks**, 250 research entries, 31 contract documents, 613
quickstart scenarios.
988 cross-spec requirement references, 112 cross-spec task references, every internal link — all
resolve. 11 OpenAPI documents valid, no duplicate path keys, FR coverage 366/366 (399/399 after 2026-09-26, including 013 and 008 FR-016a).

`/speckit-analyze` found ≈110 findings (10 CRITICAL, ~47 HIGH) — every spec was internally complete,
and all of it sat at the **seams between specs**. Resolved as C-08..C-28 in [decisions.md](decisions.md).

The **stage-0 review** (C-29..C-32, constitution 1.1.0, [ADR 0009](adr/0009-derivation-artifacts-and-diff-gates.md))
then closed the two findings that mattered most: the autonomy thresholds were to be measured on the same
incidents the prompts are tuned against, and nothing required them to be read at the moment a ceiling is
raised. The benchmark set is now sealed and a raise is gated on the build — see
[runbooks/raising-autonomy.md](runbooks/raising-autonomy.md).

## Stage 2 — implementation

**012 phases 1–2 landed 2026-09-24** (VERSION 0.5.0): the monorepo, shared foundations, tenancy as a
compile-time guarantee, the transactional outbox, the persisted workflow machine, the callback registry
and the seven queue classes.

**012 phase 3 (US1) landed 2026-09-26** (VERSION 0.10.0), the first time the Docker daemon was up:
`make bootstrap` and `make ci` — `secret-scan → db-check → format-check → lint → typecheck → build →
test-unit → test-e2e` — run end to end, 59 unit and 7 e2e tests green, 32.3s cold-cache wall-clock
against the 10-minute budget, and `.github/workflows/ci.yml` invokes exactly `make ci`. Running the
migration against a live Postgres for the first time caught two real gaps from phase 1–2 that
`typecheck`/`lint`/unit tests could not see: `workflow_transition` was missing `tenant_id` and its
index, and `prisma/migrations/migration_lock.toml` did not exist — both fixed, not worked around.

**012 phase 4 (US2) landed 2026-09-27** (VERSION 0.11.0): `gate-isolation`, `gate-undo`,
`gate-evidence`, `gate-architecture-agnostic`, `contracts-check`. Also fixed: the API could not
boot at all until this phase (`HealthController`'s DI wiring was broken since phase 1–2 — no test
had ever exercised a real `NestFactory.create`).

**012 phase 5 (US3) landed 2026-09-27** (VERSION 0.12.0): boundary lint rules, lint limits,
`deps-check`. T038 (capability-passing lint pattern) deliberately left undone — nothing in 005,
008, 009 or 010 exists yet to write a pattern against. `make ci`: 92 unit tests (98.3% coverage,
now actually enforced) + 19 e2e tests, ~27s cold-cache. Several open questions from phases 4–5
about conventions 001/010 will need to follow are recorded in `QUESTIONS.md`.

**012 phase 6 (US4) partially landed 2026-09-27** (VERSION 0.13.0): the runner protocol's pure
logic — `packages/boundary-contract`'s closed evidence/directive schemas, the capability
handshake (active/degraded/refused), independent egress/ingress validation, the bounded outbound
buffer, the redaction mechanism. 7 of 13 tasks. The other 6 (registration/heartbeat persistence,
outbound transport, runner diagnostics, runner build/Docker packaging, directive idempotency) all
need a repository/controller pattern or an `apps/runner` codebase that doesn't exist yet —
deferred rather than improvised, reasoning in `QUESTIONS.md`. `make ci`: 119 unit tests (98.9%
coverage) + 19 e2e tests, ~23s cold-cache.

**012 phase 7 (US5) landed 2026-09-27** (VERSION 0.14.0): never-wait-inside-a-job, complete —
the lint rule (setTimeout/setInterval/poll-loop, scoped to `**/processors/**`), the runtime
wall-clock budget (`runWithBudget`), the overdue/stuck-run decision logic. Two of the seven tasks
needed no new code at all: phase 1–2 already covered them. `make ci`: 131 unit tests (99.0%
coverage) + 24 e2e tests, ~24s cold-cache.

**012 phases 8–12 landed 2026-09-27** (VERSION 0.16.0): self-observation (agent-run digests, the
single-store structural test), the prompt registry (content-addressed, no update path), the BYO
fallback check, onboarding (`make help`, a rewritten README, `make bootstrap` re-verified for
real), and the analyze-pass gates (`gate-data-model`, the boundary-exception registry via
`noInlineConfig`, `deps-check`'s ADR-diff extension, `gate-no-send`). 19 of 27 tasks across the
five phases; the other 8 all wait on the same two things: a real repository/controller pattern
(001) or a real `packages/llm` provider adapter (010-adjacent) — see `QUESTIONS.md` for the
per-task reasoning. `make ci`: 164 unit tests (99.0% coverage) + 26 e2e tests, ~26s cold-cache.

**012 phase 13 (agent-driven development) not started.** Its own prerequisite section names why:
T088–T092 install a GitHub App, set branch-protection rules and name real humans in `CODEOWNERS`
— changes to the real, shared GitHub repository (`github.com:EverRest/healer`) that need explicit
sign-off, not something to do while working through a task list unattended. T084–T087 need no
live GitHub interaction and can start on request.

**001 issue-and-evidence begun 2026-09-27** (VERSION 0.17.0): T001–T004 of 57. The schema (`issue`,
`evidence`, `audit` — 9 tables) and the append-only guarantee, enforced by Postgres triggers and
proven through raw SQL against a real database, not asserted by a repository's missing update
method. Caught and fixed on the first real run: a stray `'closed'` state in `data-model.md` that
matched nothing in the actual 9-state enum, and two tables missing their required tenant-leading
index. Also fixed two real, unrelated bugs the new work surfaced: 012's `AgentKind` enum was
missing `test_author` despite `boundary-contract`'s schema already expecting it, and a real type
error in `test/containers.ts` that nothing had ever compiled before. `make ci`: 164 unit tests
(99.0% coverage) + 33 e2e tests, ~27s cold-cache.

Next: **001 phase 2** (the foundational guarantees every user story assumes — producer
attribution, evidence-requires-a-link, the persisted issue state machine), then phase 3
(deduplication and ingestion — genuine product logic with real design decisions, not
infrastructure). This is also what retroactively unblocks most of what 012 deferred (T042, T045,
T048, T080, and the persistence half of T059/T061/T070) once a real repository/controller pattern
exists to follow. 012 phase 13 (agent-driven development) still waits on user sign-off for its
GitHub-account-level actions (installing a GitHub App, branch protection, `CODEOWNERS`); T084–T087
need no live GitHub interaction and can start on request. Stage 0 S0-1 still blocks realistic
sizing of v1 and does not block this work.

| Spec | Covers | clarify | plan | tasks | analyze |
|------|--------|---------|------|-------|---------|
| 001 issue-and-evidence | `Issue` aggregate, `Evidence`, audit trail, event model | ✅ | ✅ | ✅ | ✅ |
| 002 policy-and-autonomy | Policy Engine, autonomy levels, approvals, budgets | ✅ | ✅ | ✅ | ✅ |
| 003 context-resolver | Evidence collection across the control/execution split, redaction | ✅ | ✅ | ✅ | ✅ |
| 004 architecture-graph | `Component`, `DeploymentUnit`, discovery, code/runtime/product graphs | ✅ | ✅ | ✅ | ✅ |
| 005 knowledge-and-expected-behavior | Knowledge sources, provenance, `ExpectedBehavior`, drift | ✅ | ✅ | ✅ | ✅ |
| 006 diagnosis | Hypotheses, evidence validation, is-this-a-code-problem classifier | ✅ | ✅ | ✅ | ✅ |
| 007 reproduction-and-sandbox | Reproduction engine, isolation, `INCONCLUSIVE` path | ✅ | ✅ | ✅ | ✅ |
| 008 change-and-verification | Impact analysis, TDD fix, verifier, PR automation | ✅ | ✅ | ✅ | ✅ |
| 009 autosupport | Issue intake, grounded answers, answer policy | ✅ | ✅ | ✅ | ✅ |
| 010 safe-remediation | Reversible actions, preconditions, verification, undo | ✅ | ✅ | ✅ | ✅ |
| 011 simulator-and-eval | Historical replay, benchmark harness, metrics | ✅ | ✅ | ✅ | ✅ |
| 012 engineering-foundation | Monorepo, CI, lint gates, runner packaging, observability | ✅ | ✅ | ✅ | ✅ |
| 013 regression-suite | Adopted expectations → tests → CI; a failing test becomes a `regression` issue | ✅ | ✅ | ✅ | ✅ |

Dependency order for planning: 012 → 001 → 002 → 003 → 004 → 005 → 006 → 011 → 009 → 010 → 007 → 008 → 013.

Note that **policy (002), evidence (001) and the eval harness (011) come before anything that
writes** — several exit criteria in the original brainstorm depended on components scheduled
much later, which made those phases unverifiable.

## v1 release shape

```text
Read-only core      issue → context → evidence → diagnosis, policy, audit, simulator
AutoSupport         propose only, never sends
Safe remediation    reversible actions including autonomous rollback
TDD fix + PR        L2 ceiling — human always merges
```

## Beyond v1

L3 (merge) only after a measured false-fix rate. L4/L5 per component and environment, never
globally. Wiki generator, postmortems, evidence graph views, model router.
