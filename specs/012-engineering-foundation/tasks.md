# Tasks: Engineering foundation

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/make-targets.md](contracts/make-targets.md),
[contracts/runner-protocol.md](contracts/runner-protocol.md), [quickstart.md](quickstart.md)

**Tests**: TDD is constitutional (Development Workflow), not optional. A gate's test is written
first and must be seen to fail — a gate nobody has watched fail is not known to work.

**Organization**: one phase per user story. US1–US5 are P1 and block every other spec.

## Format: `[ID] [P?] [NB?] [Story] Description`

`[NB]` marks a task with no behaviour change; it exempts that task from `gate-red-first` (FR-056, R-14).

---

## Phase 1: Setup

- [X] T001 Monorepo skeleton: `apps/{api,worker,mcp-server,runner,dashboard}`, `packages/` per [plan.md](plan.md) and FR-001; workspace configuration; each package declares its public entry surface
- [X] T002 [P] TypeScript project references across packages; a package importing past another's entry surface fails compilation
- [X] T003 [P] Vitest, Supertest and Testcontainers wiring (R-12); disposable Postgres and Redis helpers
- [X] T004 [P] Pino structured logging in `packages/shared/logging` — `tenantId` and correlation identifier on every line, redaction of secrets and customer content; `console` banned by lint (FR-034, FR-035, FR-004)
- [X] T005 [P] `packages/shared/config`: configuration validated against a schema at process start, failing fast on a missing or malformed value; the only place `process.env` is read, exposed to the rest of the code as typed values (FR-043, FR-044)
- [X] T006 Docker Compose for local development: Postgres 17 with `vector` and `pg_trgm`, Redis (ADR 0004); no Terraform, no Kubernetes (FR-050, FR-052)

---

## Phase 2: Foundational (blocks every other spec)

- [X] T007 Prisma setup with multi-schema; `prisma/schema.prisma` scaffolding; migration workflow
- [X] T008 Tables from [data-model.md](data-model.md): `workflow_run`, `workflow_transition`, `workflow_callback`; first migration (FR-029, FR-030)
- [X] T009 [P] Tables `prompt_version`, `tenant`, `tenant_provider_config`, `tenant_budget` (with `soft_threshold_pcts` as an array, matching 002's `budget_limit`), `runner_registration`, `runner_capability_resolution`, `agent_run` (FR-033, FR-038, FR-045)
- [X] T010 `packages/shared/tenancy`: request-scoped `TenantContext`; every repository takes it; a query built without it fails to type-check (FR-048)
- [X] T011 [P] Single error format and codes shared across apps; global validation pipe
- [X] T012 `packages/events`: transactional outbox — write and publish in one transaction so a rolled-back transition is never observed (FR-031, consumed by 001 FR-014)
- [X] T013 `packages/workflow`: state machine over `workflow_run`; transitions append to `workflow_transition`; **the persisted machine is the audit trail** (FR-029, 001 FR-013)
- [X] T014 `packages/workflow`: callback registry — `workflow_callback` issue, consume idempotently, count repeats; a callback for an unknown, completed or abandoned run is recorded, never discarded (FR-030)
- [X] T015 BullMQ setup: queue classes from the constitution, concurrency limits, retry with backoff, dead-letter queues; dead letters are observable
- [X] T016 [P] OpenTelemetry tracing with a correlation identifier threaded through every job, log and trace (FR-032)
- [X] T017 [P] `GET /health` and `/ready`: version, build, protocol version, dependency status — the single source the About surface and every version check read

> **Phase 1–2 implemented 2026-09-24.** `typecheck`, `lint` and the unit suite are green (48 tests).
> Two deliverables exist but were **not exercised**, because the Docker daemon was not running on the
> implementing machine: the local compose stack (T006) was never started, and the initial migration
> (T008, T009) was generated with `prisma migrate diff` — including its reverse — but never applied.
> Applying it against a live Postgres, and the e2e/testcontainers path, belong to the first run of
> phase 3's `db-check` (T021).

---

## Phase 3: US1 — The gates run on a laptop (P1)

**Independent test**: quickstart 1, 13, 27, 28, 35

- [X] T018 **Test first**: a gate invoked where the change set is not inspectable must fail, not skip (R-10, quickstart 13)
- [X] T019 `make bootstrap`: install, start infrastructure, migrate, seed — one command from a fresh clone (FR-050)
- [X] T020 `make ci` composing focused targets in the order in [contracts/make-targets.md](contracts/make-targets.md), failing at the first failure (FR-007, FR-008)
- [X] T021 [P] `db-check`: Prisma generate, schema drift against migrations, migration applicability **to a clean database and to the previous release's schema**, **every migration's reverse exercised**, every tenant-scoped table carrying `tenant_id` with a leading index, and migrations reversible without heavy data logic (FR-009, FR-010, FR-048, FR-049, quickstart 28)
- [X] T022 [P] `format-check`, `typecheck`, `build` targets (FR-008)
- [X] T023 [P] `test-unit` with risk-weighted coverage floors declared per package — 95% for `packages/domain/policy/**`, `packages/domain/evidence/**`, `packages/shared/tenancy/**` and agent output validation; 80% elsewhere (FR-011, R-11)
- [X] T024 `test-e2e` against disposable Postgres and Redis (FR-008, R-12)
- [X] T025 Shared gate harness: every gate reports a machine-readable result and **fails closed** on inability to determine (R-10)
- [X] T026 CI pipeline invoking exactly `make ci` — no steps that exist only in CI (FR-007)
- [X] T027 [P] Measure `make ci` wall-clock on a cold cache against the plan budget; record the number (FR-016)

---

## Phase 4: US2 — No endpoint and no reversible action ships untested (P1)

**Independent test**: quickstart 10, 11, 12, 29

- [X] T028 **Test first**: each of the three gates below must be shown to fail on a deliberately broken fixture before it is trusted
- [X] T029 `gate-isolation`: enumerate every HTTP endpoint from the generated contract plus every MCP tool; fail when any lacks a test asserting another tenant receives not-found (FR-013, 001 FR-015, 001 SC-004)
- [X] T030 `gate-undo`: read the reversible action catalogue (010) and fail when an entry has no passing undo test (FR-014, satisfies 002 SC-005)
- [X] T031 `gate-evidence`: fail when a persisted conclusion type has a nullable evidence reference — the rule is 001's, this gate only enforces it (001 FR-009, FR-016a)
- [X] T032 `gate-architecture-agnostic`: fail when a domain or agent package names a concrete architecture style, runtime or vendor (constitution VII, 004 SC-008, FR-016a)
- [X] T033 [P] `contracts-check`: generated OpenAPI and clients match committed artifacts; hand edits fail (FR-009, FR-012)

---

## Phase 5: US3 — Boundaries by pattern, not by name list (P1)

**Independent test**: quickstart 2, 3, 4, 5, 30, 31

- [X] T034 **Test first**: add a new package violating a boundary and assert lint fails **without any rule edit** (R-01, quickstart 3)
- [X] T035 `no-restricted-imports` patterns: cross-module `**/*/infrastructure/**`, provider SDKs outside `packages/llm/*/infrastructure/**`, `@prisma/client` outside `**/infrastructure/**` and `prisma/**`, `process.env` outside `packages/shared/config/**` (FR-002, FR-003)
- [X] T036 [P] Lint limits: file ≤ 400 lines, function ≤ 300, complexity ≤ 15, nesting ≤ 4; tests exempt (FR-004)
- [X] T037 [P] `deps-check`: dependency allowlist including the Postgres extension list from ADR 0004; permissive licences; lockfile in sync (FR-006)
- [ ] T038 Capability-passing lint patterns per [ADR 0008](../../docs/adr/0008-capability-passing.md): mutating infrastructure modules importable only from privileged execution packages — **deferred**, see QUESTIONS.md: no capability type or mutating module exists yet in any of 005/008/009/010

---

## Phase 6: US4 — The runner is a product we ship, and we debug it blind (P1)

**Independent test**: quickstart 17, 18, 19, 20, 21, 22

- [X] T039 **Test first**: handshake matrix — supported version, two minor versions back, below the floor; assert `active` / `degraded` / `refused` (R-03, quickstart 17, 18)
- [X] T040 `packages/boundary-contract`: the closed evidence shape set from [contracts/runner-protocol.md](contracts/runner-protocol.md) as versioned Zod schemas; **free-form string fields rejected** (FR-022, R-04)
- [X] T041 Egress validation on the runner and independent ingress validation on the control plane; a payload failing egress is not sent, one failing ingress is rejected and counted (FR-022)
- [X] T042 Registration and heartbeat at the declared interval: runner declares protocol version, image version, capabilities, resource limits, resource state and measured clock offset; control plane resolves the intersection and marks the capability unavailable when heartbeats stop (FR-018, FR-020) — `POST /runners/heartbeat` (`apps/api/src/runners`) reuses `resolveHandshake` unchanged and upserts `runner_registration`; the "marks unavailable when heartbeats stop" half is `findStaleRunners` (`packages/boundary-contract`), built and unit-tested but not scheduled — same gap as 001 T051/T052 (see QUESTIONS.md)
- [X] T043 Capability resolution: read-only gaps **degrade explicitly** and write to `runner_capability_resolution`; state-changing gaps **refuse** with a reason (FR-018, C-02) — resolution logic done in `packages/boundary-contract/src/handshake.ts`; T042 landed and does **not** write `runner_capability_resolution` from registration/heartbeat — its `run_id` is `NOT NULL` and names a specific investigation run, which a heartbeat has none of (see QUESTIONS.md)
- [X] T044 Compatibility floor: refuse below two minor versions or ninety days, reporting the required upgrade (FR-018, C-02)
- [X] T045 [P] Outbound-only transport: the runner initiates; no inbound connection to the customer's network ([contracts/runner-protocol.md](contracts/runner-protocol.md)) — `apps/runner/src/heartbeat-client.ts` + `main.ts`: native `fetch`, no listening socket anywhere; buffered via `OutboundBuffer` on failure and retried on reconnect (FR-021 applied to the heartbeat). Real evidence submission has no receiving endpoint yet — see QUESTIONS.md
- [X] T046 [P] Outbound buffering with a bounded size; on overflow drop oldest and record a `collection_gap`; never block the customer's systems — lossy with a record, deliberately weaker than control-plane ingestion (FR-021)
- [X] T047 Redaction on the runner: unredactable items are **withheld with a recorded gap**, never truncated and sent; no log body, source content beyond a declared excerpt, environment value or credential is transmissible by any path (R-05, FR-023) — mechanism built (two outcomes, no truncated state); the actual classification policy is 003/005's, not decided here
- [ ] T048 `make runner-diagnostics`: versions, capabilities, configuration reduced to presence-only, queue depths, timing histograms, own error signatures, last N exchanges as schema identifier and size — **no customer data** (R-06, FR-024) — **deferred**, see QUESTIONS.md: depends on T042's state
- [ ] T049 [P] `make runner-build` stamping the immutable version and checksum, `runner-contract-test`, `runner-compat-test` (FR-017, FR-022) — `runner-contract-test`/`runner-compat-test` done: thin Makefile/`pnpm` targets over the already-tested `packages/boundary-contract` closed schema (R-04) and handshake floor (R-03); `runner-build` stays deferred to T050, which builds `apps/runner/Dockerfile` per ADR 0014
- [ ] T050 Runner image plus exactly one deployment wrapper — Docker Compose (C-39); upgrade and rollback defined against the image (C-01, FR-019) — **deferred**, see QUESTIONS.md
- [X] T051 Directive idempotency by directive identifier — a directive delivered twice executes once (FR-028, [contracts/runner-protocol.md](contracts/runner-protocol.md)) — `apps/runner/src/directive-dispatcher.ts`: a bounded, drop-oldest `BoundedSeenSet` of directive ids (runner-local, not control-plane-tracked); proven at the dispatcher's own unit-test level, since no real directive producer exists yet (`ControlPlaneDirective`'s closed union has no id field — see QUESTIONS.md)

---

## Phase 7: US5 — Never wait inside a job (P1)

**Independent test**: quickstart 6, 7, 24, 25, 26

- [X] T052 **Test first**: a processor containing a sleep, a poll loop or an await on external completion fails lint (R-02, quickstart 6)
- [X] T053 Lint rule for `**/processors/**` implementing T052 (FR-026)
- [X] T054 Runtime wall-clock budget per job: exceeding it fails the job, records the breach as a `workflow_transition` with cause `timeout` and raises an alert — never a silent late success (FR-027, quickstart 7) — `runWithBudget`/`runJobWithBudget`; "alert" is a structured error log, no dedicated alerting sink exists yet
- [X] T055 Long-wait pattern: every external wait is a persisted state plus an inbound callback; CI, deploy and verification ticks all use it (FR-025, ADR 0003) — already satisfied by phase 1–2's `machine.ts`/`callbacks.ts`: `CallbackKind` already names `ci_result`, `deploy_result`, `verification_tick`
- [X] T056 [P] Scheduled tick resolving `workflow_run.deadline_at`, so a callback that never arrives is still resolved (FR-025) — decision logic (`findOverdueRuns`) done; the scheduled job itself needs the repository that doesn't exist until 001/T042
- [X] T057 [P] Worker restart resumes runs from persisted state; nothing is lost or repeated (FR-029, quickstart 24) — satisfied by construction: `WorkflowRun.state` is the resumption point (T013); no separate resume code path to write
- [X] T058 [P] Periodic stuck-run check: a non-terminal run with neither a pending callback nor a deadline is reported (FR-029, data-model invariant, quickstart 26) — `findStuckRuns` batches phase 1–2's `isStuck`; the scheduled tick itself is the same deferred repository as T056

---

## Phase 8: US6 — Observing ourselves is the audit trail (P2)

**Independent test**: quickstart 16, 34

- [X] T059 `agent_run` recording: model, provider, prompt version, tokens, cost, tool calls as **digests not values**, policy decision, outcome; the recorded prompt version MUST resolve (FR-033, FR-039) — `digestToolCallArguments` built and tested; the write path itself needs the repository deferred since T042
- [X] T060 **Test**: no second store of the **agent-run facts** exists — model, prompt version, tokens and cost live only in `agent_run`, and 001's `audit_entry` reaches them through `agent_run_id` while indexing every non-agent actor too; the assertion is "no duplicate agent-run fields anywhere", not "only one table" (FR-033, C-13, 001 FR-012) — `prisma/agent-run-single-store.test.ts`, watched to fail on a planted duplicate field then reverted
- [ ] T061 [P] Cost accounting shared with 002's budgets and 011's cost metrics — measured, never estimated (FR-036) — **deferred**, see QUESTIONS.md: needs 002/011, which don't exist
- [X] T062 [P] Assertion that logs, traces, metrics, error reports and evidence contain no secret, customer source or log body; sampled check in CI (FR-035) — extended `logging.test.ts` with a whole-line scan (not per-field) for private-key material and credentialed URLs

---

## Phase 9: US7 — An old audit entry resolves to the exact prompt (P2)

**Independent test**: quickstart 15, 16, 33

- [X] T063 **Test first**: attempt to update a published `prompt_version`; assert rejection. Republish identical content → no-op; changed content → new version (R-07, quickstart 15) — enforced by the module's surface having no update function, not by a runtime check; the DB-level append-only trigger pattern is 001 T003's, not built here
- [X] T064 `packages/prompts`: content-addressed publish computing the digest; runtime resolves by version identifier only, never by path (FR-038, FR-039)
- [ ] T065 [P] Eval history per prompt version resolved from 011's run reports — no eval result, no promotion to a production default; nothing is copied here (FR-040) — **deferred**, see QUESTIONS.md: needs 011

---

## Phase 10: US8 — Misconfiguration fails at startup (P2)

**Independent test**: quickstart 23

- [ ] T066 Secret manager integration; no secret in the repository; configuration holds references, never values (FR-042) — **deferred**, see QUESTIONS.md: choosing a secret manager SDK is a new-dependency/ADR decision, not made silently
- [ ] T067 Per-tenant provider resolution on every model call, from the tenant context and never a process-global client (FR-045, ADR 0006) — **deferred**, see QUESTIONS.md: `packages/llm` has no provider adapter yet to resolve to
- [ ] T068 **Test first**: BYO tenant with an induced provider failure makes **no call to a Healer-provided provider**; work fails and retries (FR-046, SC-016, R-08) — **deferred**, see QUESTIONS.md: needs a real provider client with retry logic, which is `packages/llm`'s job, not built yet
- [X] T069 `tenant_provider_config.fallback_scope` as a single-value enum, so cross-boundary fallback is **not representable** (R-08) — already done in phase 1–2's schema (`enum FallbackScope { within_tenant_providers }`), confirmed still true
- [X] T070 [P] Continuous check: no `agent_run` for a BYO tenant carries a Healer-provided provider (FR-046, data-model invariant) — `findByoFallbackViolations`; the scheduled query against real rows is the same deferred repository as T042/T056

---

## Phase 11: US9 — A new developer starts without tribal knowledge (P3)

- [X] T071 [P] `README` quickstart verified by running it on a clean machine (FR-051) — README rewritten to `make bootstrap`/`make ci`; `make bootstrap` re-run for real (not simulated) and confirmed idempotent
- [X] T072 [P] `make help` listing every target with one line each — self-documenting via `##` comments; caught and fixed a real bug in its own grep pattern (`[a-zA-Z_-]` excluded digits, silently dropping `test-e2e`) before trusting it
- [ ] T073 Run the whole of [quickstart.md](quickstart.md) — all 35 scenarios, including the ones that must fail — **not yet**: several scenarios need phases not complete yet (runner build/Docker, agent-driven development, phases 12–13); this is 012's final-milestone check, revisit when every phase lands

---

## Phase 12: Analyze-pass additions

Added after `/speckit-analyze`, each closing a requirement that had no task. Numbered from the end so
the identifiers other specs already cite stay stable; each line names the phase it belongs to.

- [X] T074 [Phase 3] `secret-scan` as the **first** target in `ci`: no secret material and no committed environment file, run before anything can bake a key into an artifact; **test first** — plant a private key and a `.env` and watch both fail (FR-008, FR-042, quickstart 27)
- [X] T075 [Phase 3] Irreversible migrations: a destructive migration fails `db-check` unless it is explicitly marked **and** carries a recorded approval; the reversible path stays the default and every down migration is exercised (FR-049, quickstart 35)
- [X] T076 [Phase 4] `gate-data-model`: a change set altering the database schema fails unless the owning specification's `data-model.md` changed in the same change set; fails closed when the change set is not inspectable (FR-015, R-10, quickstart 29) — checks "some data-model.md changed", not yet attribution to the *owning* spec specifically (no table→spec map exists); shares `scripts/lib/changed-files.mjs` with T078
- [X] T077 [Phase 5] Boundary-exception registry: a recorded entry referencing an ADR and naming an owner is the **only** form an exception takes; **inline suppression of a boundary rule fails lint**, and the list is reviewable (FR-005, quickstart 30) — `linterOptions.noInlineConfig: true` (repo-wide — ESLint has no per-rule switch), `docs/boundary-exceptions.md` as the registry, empty today
- [X] T078 [Phase 5] `deps-check` extension: a new runtime dependency fails the build unless an ADR referencing it exists in the same change set; fails closed when the change set is not inspectable (FR-006, VIII, quickstart 31) — caught a real gap in itself: `@nestjs/swagger` (added in phase 6) had no ADR; [ADR 0012](../../docs/adr/0012-openapi-contract-generation.md) written to close it, confirmed the gate then passes
- [ ] T079 [P] [Phase 2] **Test**: drop the pgvector index and rebuild it from Postgres — every previously retrievable item is retrievable again, with zero loss; Postgres is the source of truth and the index is secondary (FR-047, SC-019, quickstart 32) — **deferred**: no feature uses pgvector yet (005 not implemented), nothing to retrieve
- [ ] T080 [Phase 8] Healer operator access to a tenant's traces and run records: scoped to the named tenant and **itself written to the audit trail**, so reading a customer's data is a recorded act (FR-037, quickstart 34) — **deferred**: needs 001's `audit_entry`
- [X] T081 [Phase 9] Prompt selection pinned per agent and resolved deterministically; **model output cannot alter the prompt in use** — the selection is not a value any agent response can reach (FR-041, quickstart 33) — already satisfied by T064's design: `resolveByVersionId` is the only resolver, keyed by an identifier pinned at directive-construction time, never by a value a model response could supply

---

- [X] T082 `gate-no-send`: monorepo-wide check that no package outside the egress allowlist imports an outbound mail, SMS, chat or HTTP-client module; the allowlist contains no support package (009 SC-005). **Test first** — add a `packages/integrations/support-send` fixture and assert the gate fails on it, because scoping the rule to the support packages is what made the original guarantee defeatable
- [ ] T083 `gate-ceiling`, third assertion: fail when the diff **raises** a level in `ACTION_CEILING` — gives a level to a class that has none, or increases one — and cites no `threshold_derivation` artifact the gate can resolve from the working tree. **Test first** with the four fixture branches of 002 T086. It reads a committed artifact rather than the control-plane database, so the gate holds no credentials and a database outage cannot turn it into noise; unresolvable means fail, per the gate semantics (002 FR-008a, 002 SC-009, 011 FR-021c, `contracts/make-targets.md`) — **deferred**: needs 002's `ACTION_CEILING`/`threshold_derivation`, not implemented

## Phase 13: US10 — A coding agent implements a task, and only the gates decide (P2)

**Goal**: an agent can take one task to a reviewable pull request, and cannot land anything the gates
or a human did not accept. **Independent test**: quickstart 36–41.

**Prerequisite outside this list**: the repository under version control on a host with CI (R-13).
Until then T084–T087 can be written and tested locally against fixture repositories, and T088–T091
wait.

- [ ] T084 [US10] Author-identity resolver in `scripts/gates/agent-identity.mjs`: pull-request author and the workflow's triggering actor resolved against the GitHub API; `type: Bot` on either → agent; either unresolvable → agent; outside CI, agent unless the developer states otherwise. **Test first** with fixtures for bot, human and unresolvable identities (FR-054, R-13, quickstart 38)
- [ ] T085 [US10] `gate-agent-scope` in `scripts/gates/agent-scope.mjs`: reads the protected-path list from the fenced block in [contracts/make-targets.md](contracts/make-targets.md) — the gate parses the contract rather than holding a copy; for an agent-authored change set fails on any protected path, on a deleted test file present on the base revision, and on a removed assertion line in such a file; fails closed when the base is missing. **Test first** — one fixture per protected-path line plus quickstart 37, each watched to fail (FR-055, SC-021, R-15, R-10)
- [ ] T086 [P] [US10] `gate-red-first` in `scripts/gates/red-first.mjs`: base-revision checkout in a temporary worktree, the change set's added or modified test files placed over it, only those files run; passes when at least one fails; skipped when the task line carries `[NB]` **on the base revision's** `tasks.md`. **Test first** — quickstart 39, including an `[NB]` added in the same change set (FR-056, R-14)
- [ ] T087 [US10] Add `gate-agent-scope` and `gate-red-first` to the `Makefile` as focused targets and to `ci` in the order of [contracts/make-targets.md](contracts/make-targets.md); both no-ops for a human-authored change set (needs T020)
- [ ] T088 [US10] Pull-request template `.github/PULL_REQUEST_TEMPLATE/agent-task.md` with task and requirement identifiers; `gate-agent-scope` fails an agent-authored pull request whose description names no task identifier present in the base revision's `tasks.md` (FR-053, quickstart 40)
- [ ] T089 [US10] Agent workflow `.github/workflows/agent-task.yml`: `workflow_dispatch` or schedule, input `TASK_ID`, GitHub App installation token (contents and pull requests: write), `timeout-minutes` as the wall-clock budget, one spend-limited model key per job class; a task not marked `[P]` joins one `concurrency` group, so the host serialises it against other agent jobs; ends in a pull request, or a draft labelled `needs-decision` carrying the open question, or a stopped branch with the budget breach recorded (FR-058, FR-059, R-16)
- [ ] T090 [US10] Repository ruleset on the default branch per R-16 — pull request required, code-owner review with a humans-only `CODEOWNERS`, most-recent-push approval, restrict updates with maintainers as pull-request-only bypass actors; verify quickstart 41 and record the settings and the re-check trigger in `docs/runbooks/agent-development.md`, indexed in `docs/README.md` (FR-057, R-16)
- [ ] T091 [US10] `AGENTS.md`: a short "working as an automated agent" section — one task per pull request, the `[NB]` marker, the stop rule and the `needs-decision` draft; the rules themselves stay in this spec and the contract, not restated (FR-053, FR-058)
- [ ] T092 [US10] Scheduled workflow `.github/workflows/ruleset-drift.yml` reading the default-branch ruleset through the GitHub API and failing on any difference from the settings T090 declares; **test first** against a fixture ruleset missing the code-owner rule (SC-022, C-40)
- [ ] T093 [Phase 6] Runner-side inference: `inference` as a declared capability; every `agent_directive` refused without it; prompt fetched by identifier and refused on digest mismatch; provider credential resolved from the customer's secret manager, never from a directive. **Test first** — a runner without the capability, and a prompt with a wrong digest (FR-046a, C-35, ADR 0010)
- [ ] T094 [Phase 8] `agent_run` written from `agent_run_report` with `executed_in = runner` and `runner_instance_id`; reported cost reconciled against provider usage per tenant key, a mismatch recorded (FR-033, FR-046a, C-34)
- [ ] T096 [Phase 8] OpenTelemetry Collector configuration in `docker/` exporting traces, logs and metrics to Grafana Cloud; `tenantId` replaced by a keyed hash before export, resolvable only through the audited operator path; alert rules for workflow budget breach, dead-letter depth, `timeout` rate, cost per issue and heartbeat gaps. **Test first** — a planted tenant identifier never appears in exported telemetry (FR-032, FR-035, FR-037, R-17, C-41)
- [ ] T095 [Phase 6] Runbook `docs/runbooks/provider-key-rotation.md`, indexed in `docs/README.md`: issue the new per-tenant key, customer stores it, overlap window, revoke the old key; the runner re-resolves credentials on the next directive (C-38)

---

## Dependencies

```text
Phase 1 (T001–T006)
   └─▶ Phase 2 (T007–T017)   blocks every other spec
          ├─▶ Phase 3 · US1 (T018–T027)
          ├─▶ Phase 4 · US2 (T028–T033) ← T029/T030/T031 need routes and a catalogue to inspect,
          │                                 so they land with 001 and 010 respectively
          ├─▶ Phase 5 · US3 (T034–T038)
          ├─▶ Phase 6 · US4 (T039–T051) ← T040 before everything else in this phase
          ├─▶ Phase 7 · US5 (T052–T058) ← T055 needs T013, T014
          ├─▶ Phase 8 · US6 (T059–T062)
          ├─▶ Phase 9 · US7 (T063–T065)
          └─▶ Phase 10 · US8 (T066–T070)
Phase 11 (T071–T073) last
Phase 12 (T074–T081) lands with the phase each line names, not after Phase 11
Phase 13 · US10 (T084–T092) ← T087 needs T020; T088–T092 need the repository on GitHub (C-37)
T093–T095 land with the phase each line names
```

**Explicit dependencies beyond phase order**

- T029 (`gate-isolation`) needs at least one route from 001 to inspect; write the gate, then enable it in `ci` once 001 Phase 3 exists.
- T030 (`gate-undo`) needs 010's catalogue; same approach — gate first, enabled when the catalogue lands.
- T032 (`gate-architecture-agnostic`) needs 004's package to have something to check.
- T020 (`make ci`) composes targets that arrive across phases 3–6; it starts as a subset and grows, and the subset is always green.

## Parallel groups

- Setup: T002–T005 together.
- Foundational: T009, T011, T016, T017 after T007–T008.
- Gates: T033 alongside T029–T032 — different scripts, different files.
- Runner: T045, T046, T049 after T040–T043.

## Strategy

1. **Phase 1–2 first and completely.** Every other spec's Phase 1 depends on the workflow machine,
   the outbox, tenancy and the gate harness existing.
2. **T040 (the closed boundary schema) before any runner work**, because it is the contract three
   other specs generate against — 003, 004 and 010 all produce or consume its shapes.
3. Phases 3–5 next: the gates. Written before there is much to gate, deliberately — a gate added
   after the violations exist is a gate that starts life red and gets disabled.
4. Phase 6–7 before anything in 007 or 008 begins: no reproduction and no change work can be
   correct without the boundary contract and the never-wait discipline in place.
5. Phases 8–10 can proceed in parallel with other specs' early phases.
