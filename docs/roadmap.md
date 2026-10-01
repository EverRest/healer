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

**001 phase 2 (Foundational) landed 2026-09-27** (VERSION 0.26.0): T005–T014, all 14 of phase 1–2.
Producer attribution, evidence-requires-a-link, the persisted issue state machine (`state-machine.ts`,
same technique as 012's `machine.ts` `step()` — a closed graph is the authority, not the caller —
deliberately not the same `WorkflowState` union, since `issue.state` has no job-hanging concern to
guard against), the `normalisation_ruleset` FK and append-only guarantee, outbox publishers for the
four contract events with a real producing operation today (`IssueDetected`/`IssueStateChanged`/
`EvidenceRecorded`/`EvidenceDetached` — 012 T012 had built only the pure outbox logic, no Prisma
table, until now), and a per-method compile-time proof that tenant scoping cannot be omitted.
`packages/events` gained its first real infrastructure code. `make ci` green: 76 e2e tests, all 16
gates.

**001 phases 3–8 landed 2026-09-28** (VERSION 0.44.0): deduplication and ingestion, evidence and
its links, correlation, the audit trail, the timeline and evidence graph, staleness, evidence
retention, merge and unmerge, issue deletion with a content-free tombstone, and the human close.
56 of 57 tasks; T056 (running all 27 quickstart scenarios) is the one left. What 001 decided but
did not build — nothing schedules the sweep or retention, a merged issue's later signals open a new
issue, audit action keys wait on 002 — is indexed at the end of `QUESTIONS.md`. `make ci`: 408 unit
+ 332 e2e tests, all gates.

**004 architecture-graph phases 1–2 landed 2026-09-30** (VERSION 0.45.0): the architecture graph's
foundation, T001–T017 of the full spec. `Component`/`DeploymentUnit`/`Repository` over one
`graph_node`/`graph_edge` pair, provenance and versioning enforced by database constraints and a
partial unique index (not only by types), `edge_provenance` append-only with a true `MAX()`
maintaining the edge's denormalised strength/confidence, the `gitlab`/`kubernetes`/`otel`
`DiscoveryAdapter` skeletons, and the four discovery boundary shapes corrected in
`packages/boundary-contract` (012 T040 had pre-built placeholder versions with different fields).
Built as five reviewed batches, each with two independent reviewers before merge; review caught and
fixed a trigger that would have silently rewritten closed/historical graph versions, a tenant-blind
FK on all six attribute tables, and several concrete bypasses in the `graph:confirm` capability
gate before it actually held. `make ci` green (the one flaky signal was 001's own previously-known
load-sensitive replay test, confirmed transient by isolated retry). Phase 3 (US1, real discovery
collection) not started.

**002 policy-and-autonomy phases 1–3 landed 2026-09-30** (VERSION 0.46.0): the policy engine's
foundation and US1, T001–T033 of the full spec — the gate every writing feature (008, 010) must
call before it may mutate anything. The pure evaluator (closed `DecisionInput`, the `DENY`-seeded
lattice, the closed predicate vocabulary, `ACTION_CEILING` with no configuration input),
`PublishRuleset`/`EvaluateAndBind`/`ExplainDecision` as the writing and read-only callers of one
shared evaluation path, and the continuous reconciliation checks (`check:policy-coverage`,
`check:decision-replay`). Built as nine reviewed batches, each with two independent reviewers
before merge — including one CRITICAL fix inside a single batch (the autonomy ceiling's clamp
never firing for the ordinary no-grant-yet state) and, after all 33 tasks individually passed
review, a whole-branch pass that found two further CRITICAL bugs invisible to any single task's
review: consumption never checked a decision's outcome was actually `allow`, and `actionClass` was
caller-supplied and never checked against the action registry, undermining the un-exceedable
ceiling at its root. Both fixed and re-reviewed clean, along with a reproduced replay crash and the
coverage check's own false positive against its own writes. Autonomy grants, approvals and budgets
(phases 4–7) don't exist yet; scoped accordingly, extension points recorded in `QUESTIONS.md`
rather than stubbed or silently assumed closed.

**012 phase 6 (US4) fully landed 2026-10-01** (VERSION 0.47.0): the six tasks 001's
repository/controller pattern unblocked — registration and heartbeat (`POST /runners/heartbeat`),
`apps/runner`'s first real source (outbound-only transport, directive idempotency), the runner's
Docker image and `make runner-build`/`docker-compose.runner.yml` (ADR 0014), and
`make runner-diagnostics`. Built as four reviewed batches, each with two independent reviewers
before merge, plus two full rebases onto master as 004 and 002 landed in parallel. Real bugs found
and fixed across review rounds: a heartbeat that could silently un-revoke a revoked runner; an
unhandled tenant-FK violation surfacing as an opaque 500; a directive marked "seen" before its
handler ran, so a genuine failure could never retry; a heartbeat-buffering design that silently
dropped directives from every buffered response but the last (reversed — a heartbeat needs no
FR-021 durability, it is a liveness signal, not evidence); a non-hermetic `.dockerignore` that made
even an unchanged rebuild refuse itself; Prisma/TypeScript actually present in the shipped runtime
image despite a scoped install; a drain-timeout ceiling that could silently exceed the compose
file's `stop_grace_period`, closed by capping the interval in `loadRunnerConfig` rather than
trusting a comment; and a diagnostics pidfile that trusted bare PID liveness as identity, closed
with a per-process nonce. Both rebases onto master surfaced their own regression — a test file
unique to this branch carried a stale `createApiModule` call invisible to `pnpm run typecheck`
(this app's root-level `*.e2e.test.ts` files fall outside its `tsconfig.json`'s `include`) — found
by running the full suite, not by any static check, and fixed. One Docker-backed e2e test stays
flaky on this shared development machine after five genuine, independent fixes; decided with Pavlo
not to block this release on it, full investigation and fix options in `QUESTIONS.md`. Real CI
(GitHub Actions, agreed as the immediate next step) may settle whether it reproduces elsewhere.

Next: **002 phases 4–7** (autonomy grants, reversible-action governance, budgets, approvals) and
**a GitHub Actions CI workflow running `make ci` on push/PR** (needs its own ADR — the first CI/CD
pipeline this repo will have). 012 phase 13
(agent-driven development) still waits on user sign-off for its GitHub-account-level actions
(installing a GitHub App, branch protection, `CODEOWNERS`); T084–T087 need no live GitHub
interaction and can start on request. Stage 0 S0-1 still blocks realistic sizing of v1 and does not
block this work.

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
