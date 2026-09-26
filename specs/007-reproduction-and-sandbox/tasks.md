# Tasks: Reproduction engine and isolated execution

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/ladder.md](contracts/ladder.md),
[contracts/test-runner-adapter.md](contracts/test-runner-adapter.md),
[contracts/events.md](contracts/events.md), [contracts/openapi.yaml](contracts/openapi.yaml),
[quickstart.md](quickstart.md)

**Prerequisites**:

- [012](../012-engineering-foundation/tasks.md) phases 1–2 — workflow machine, callback registry,
  outbox, tenancy context, gate harness.
- [012](../012-engineering-foundation/tasks.md) phase 6 — the runner as a shipped product: the
  closed boundary schema set (012 T040), capability resolution and refusal (012 T043), outbound-only
  transport, directive idempotency. **Nothing in this feature executes without it.**
- [006](../006-diagnosis/tasks.md) phase 9 — the reproduction directive: `suggestedRung`, `maxRung`,
  entry point, preconditions and the failing observable. The directive is this engine's input.
- [001](../001-issue-and-evidence/tasks.md) phase 2 — the versioned `normalisation_ruleset` a `FAIL`
  is decided against, and append-only evidence.

**Tests**: TDD is constitutional (Development Workflow), not optional. Every denial, every "this can
never be `PASS`" and every absent column gets a test that is **seen to fail** first. A denial nobody
has watched happen is not known to work.

**Organization**: one phase per user story. US1–US4 are P1 and block 008.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [ ] T001 Packages `packages/domain/reproduction` (control plane) and `packages/sandbox` shipped inside `apps/runner` (execution plane), each with its own entry surface (012 FR-001, [plan.md](plan.md) Structure decision)
- [ ] T002 [P] Prisma models for schema `reproduction` per [data-model.md](data-model.md); first migration; `tenant_id` and an index `(tenant_id, …)` on every table (FR-030, [prisma rules](../../.claude/rules/prisma-migrations.md))
- [ ] T003 [P] `ladder_rung` seeded as reference data in frozen order — `unit` 1, `request` 2, `data` 3, `concurrency` 4, `load` 5, `external_state` 6 — with `repeat_policy`, `default_wall_clock_s` and `requires_fixture` (R-01, [contracts/ladder.md](contracts/ladder.md))
- [ ] T004 [P] `sandbox_profile` as versioned, immutable rows; `egress_allowlist` is **per profile** and applies to the **prefetch phase only** — the run container's absent route is not a row — and `note` is rendered wherever a profile version is shown, on the run detail view and in the handoff, so a limit change a year old stays explicable (FR-010, FR-011, R-08)
- [ ] T005 [P] Database rules rejecting `UPDATE` and `DELETE` on `rung_attempt` and `egress_denial` (data-model, append-only)
- [ ] T006 [P] Zod schemas for the directive and the result exactly as [contracts/ladder.md](contracts/ladder.md) defines them, stamped contract version `1` (R-01)
- [ ] T007 `make sandbox-redteam` and `make adapter-conformance` registered inside `make ci` — both are gates, not optional suites (SC-003, SC-004, quickstart)

---

## Phase 2: Foundational (blocks US1–US7)

- [ ] T008 **Test first**: assert the rung vocabulary is defined in exactly one place — a second enum listing the six rungs anywhere in the repository fails the check (R-01, 006 R-13)
- [ ] T009 The `ladder_rung` import surface 006 consumes; adding a rung is a data change plus a contract version bump visible to 006, 008 and 011 (R-01)
- [ ] T010 `reproduction_attempt` and `rung_attempt` with the checks from [data-model.md](data-model.md): `reproducing_rung NOT NULL` **iff** `result = 'FAIL'`, `inconclusive_reason NOT NULL` **iff** `result = 'INCONCLUSIVE'`, `handoff_ref NOT NULL` when `INCONCLUSIVE`, unique `(attempt_id, rung_key)` (FR-004, R-05)
- [ ] T011 `execution_run` with the **immutable execution identifier**; every artefact, log, test result and evidence record references it (FR-013)
- [ ] T012 The climb as a persisted state machine of **short jobs** over 012's workflow machine — a rung is a job, the ladder is not (FR-002, 012 T013, [plan.md](plan.md) Performance Goals)
- [ ] T013 Directive dispatch to the runner over the outbound-only transport, idempotent by directive identifier; the control plane never opens a connection into the customer's network (FR-009, 012 phase 6)
- [ ] T014 [P] Boundary mapping per [R-17](research.md): results cross only as `test_result`, `error_signature`, `file_path`, `tool_output_summary` and `collection_gap` — **nothing new is added to the closed list** (FR-026, 012 T040)
- [ ] T015 [P] Tenant scoping on every repository method; a query built without `TenantContext` fails to type-check (FR-030, 012 T010)
- [ ] T016 [P] Evidence links emitted by the run itself as it executes, plus an audit entry per run (FR-029, 001 FR-008, 001 FR-012, 001 T006)
- [ ] T017 [P] Outbox publishers for every event in [contracts/events.md](contracts/events.md), written in the same transaction as the state they describe — `ReproductionCompleted` on every terminal attempt result including `PASS` and `INCONCLUSIVE`, `ReproductionEscalatedToHuman`, `SeparateDefectFound`, `FixtureBlockedByScan` — and a `workflow_callback` kind `ci_result` registered for the delegation wait; **nothing publishes eligibility** (012 T012, 012 T014, R-16)

**Checkpoint**: the vocabulary is frozen, the result shape is closed, and the ladder runs as short jobs.

---

## Phase 3: US1 — Nothing is modified until something fails (P1)

**Goal**: a `FAIL` is signature equality, and the change path is closed by a view no code can write.

**Independent test**: quickstart 1, 2, 3, 4, 5, 13, 14, 15, 16, 17

- [ ] T018 **Test first** [US1] Propose a change with no reproduction on record → refused with `blockedBy = [no_attempt]`, which requires the view to return a row for an issue that has never been reproduced (FR-001, SC-001, R-16, quickstart 2)
- [ ] T019 [US1] `change_eligibility` as a read-only SQL view **left-joined from `issue.issue`** so every issue has a row: `eligible = coalesce(latest attempt result = 'FAIL', false)` plus `blocked_by` as a closed-set **array** carrying `no_attempt`, `not_reproduced` or an inconclusive reason — the same shape as 006's `fix_eligibility.blocked_by` (R-16, FR-001, C-08)
- [ ] T020 **Test first** [US1] Search the generated API and the repositories for any way to set change eligibility; assert none exists — it is a view (R-16, quickstart 3)
- [ ] T021 **Test first** [US1] Make 006's `fix_eligibility` true with 007 `PASS`, then the reverse; the change is refused in both directions and neither view is writable (R-16, quickstart 5)
- [ ] T022 **Test first** [US1] Make the sandbox throw a different exception at the same entry point → `INCONCLUSIVE` / `signature_mismatch` plus a `separate_defect_finding`, **never `FAIL`** (FR-005, R-02, quickstart 14)
- [ ] T023 [US1] Signature equality under the **issue's own recorded** `normalisation_ruleset` version: identical normalised `exceptionType`, identical normalised `errorCode`, the issue's normalised frame sequence a **contiguous suffix** of the observed sequence, identical `endpointTemplate` where the issue carries one — reusing 001's normalisation rather than writing a second matcher (FR-005, R-02, quickstart 13, 15, 16)
- [ ] T024 **Test first** [US1] Publish a new normalisation ruleset, then re-run an old issue; matched under the version the issue recorded, not the newest (R-02, quickstart 17)
- [ ] T025 [US1] `separate_defect_finding` written and surfaced whenever a run reproduces *a* failure that is not *the* failure — it may be a second bug (FR-005, R-02)
- [ ] T026 [US1] The reproduction assertion derives from the issue's evidence — observed error signature, violated contract, or an adopted `ExpectedBehavior` — and **never from the diagnosis narrative** (FR-008, constitution II)
- [ ] T027 [US1] `PASS` marks the diagnosis unconfirmed by execution and leaves the change path closed (US1 scenario 2, quickstart 4)
- [ ] T028 [US1] End-to-end: a seeded defect produces a reproduction that fails on the affected commit and passes on the fixed commit; only then is the change path open (US1, quickstart 1)
- [ ] T029 [P] [US1] `GET /issues/{issueId}/change-eligibility`, `/reproduction` and `/reproduction/attempts`; `POST /issues/{issueId}/reproduction` refusing `NOT_FIX_ELIGIBLE` — sandbox time is not spent on an issue the change path is already closed for ([contracts/openapi.yaml](contracts/openapi.yaml))
- [ ] T030 [P] [US1] Continuous check `check:change-gate` — no change plan exists without a recorded `FAIL` (SC-001)

**Checkpoint**: constitution III holds structurally. 008 can be built against a gate it cannot bypass.

---

## Phase 4: US2 — The ladder, cheapest rung first (P1)

**Independent test**: quickstart 6, 7, 8, 9, 10, 11, 12

- [ ] T031 **Test first** [US2] An issue reproducible at `unit` stops at `unit`, and **no `rung_attempt` row exists for any higher rung** — the absence is what SC-002 reconciles (SC-002, quickstart 6)
- [ ] T032 [US2] The climb rule: `order by rung_order` ascending, stop at the first `reproduced` — one comparison, no branch per rung (FR-002, R-01)
- [ ] T033 **Test first** [US2] A directive with `suggestedRung = concurrency` still begins at `unit`; the hint changes the search, never the start (006 R-13, ladder contract, quickstart 11)
- [ ] T034 **Test first** [US2] A directive with `maxRung = request` on an issue reproducible at `data` records `data` as `skipped` / `above_max_rung` and returns `INCONCLUSIVE` — not a silent stop (FR-003, quickstart 10)
- [ ] T035 [US2] Closed skip-reason set — `preconditions_unavailable`, `above_max_rung`, `no_entry_point`, `no_harness`, `grant_absent`, `budget_exhausted` — and a skip continues the climb (R-03, FR-003)
- [ ] T036 **Test first** [US2] No concurrency entry point exists → `skipped` / `no_entry_point`, **not** `not_reproduced`; only `not_reproduced` is evidence (R-03, quickstart 9)
- [ ] T037 [US2] `error` outcome with required `error_detail`, distinct from both `skipped` and `not_reproduced` (R-03)
- [ ] T038 [US2] Per-rung recording of outcome, duration and resource cost, with each cheaper rung's rejection reason recorded on the way up (FR-003, quickstart 8)
- [ ] T039 [US2] Budget refusal between rungs → `INCONCLUSIVE` / `budget_exhausted` with the ladder state preserved (FR-027, 002 FR-011, quickstart 12)
- [ ] T040 [P] [US2] Fixtures reproducing at each of the six rungs; assert every one stops at its own rung and none climbs past it (quickstart 7)
- [ ] T041 [P] [US2] `GET /reproduction/attempts/{attemptId}/ladder` — every rung attempted, skipped or errored, with its reason (FR-003)
- [ ] T042 [P] [US2] Continuous check `check:ladder-monotonic` — no rung attempted above the reproducing rung (SC-002)

---

## Phase 5: US3 — "I could not reproduce this" is an answer (P1)

**Independent test**: quickstart 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28

- [ ] T043 **Test first** [US3] Force each of the ten `inconclusiveReason` values; **all ten reach a human and none is recorded as `PASS`** (R-05, SC-006, FR-006, quickstart 25)
- [ ] T044 [US3] The closed ten-value `inconclusive_reason` set; `INCONCLUSIVE` stays one result rather than becoming ten outcomes every consumer must handle (R-05, FR-004)
- [ ] T045 [US3] `INCONCLUSIVE` routes to a human with a `handoff_ref` and is never represented as a system error; `ReproductionCompleted` is published for all three results and `ReproductionEscalatedToHuman` alongside it here (FR-006, [contracts/events.md](contracts/events.md), quickstart 22)
- [ ] T046 [US3] `GET /issues/{issueId}/reproduction/handoff`: every rung with outcome, timing and resource cost, the rejected hypotheses carried from 006, and the separate-defect findings (FR-006, quickstart 23)
- [ ] T047 [US3] **Test** `INCONCLUSIVE` refuses a change for the same reason `PASS` refuses it (US3 scenario 3, quickstart 24)
- [ ] T048 [US3] `commit_unavailable`: the target commit force-pushed or its branch deleted → `INCONCLUSIVE`, and the correlated deploy evidence is preserved (spec edge case, quickstart 26)
- [ ] T049 [US3] `build_failure` and `environment_failure` distinguished from a test failure, each with the failing output as evidence (FR-017, quickstart 27)
- [ ] T050 [US3] `capability_refused`: a runner below the capability floor → `INCONCLUSIVE`, and the rung skip crosses the boundary as a `collection_gap` (012 T043, R-17, quickstart 28)
- [ ] T051 **Test first** [US3] A race reproducing 3 runs in 10 → `FAIL` with `intermittent = true` and `observedRate = 0.3` on the reproducing rung's row, **copied** to the attempt record and carried to 008; assert the attempt-level counters equal that rung's and are not a sum over rungs (FR-007, R-18, quickstart 18)
- [ ] T052 [US3] Repeat policy per rung class: rungs 1–2 run once plus one confirming repeat on `FAIL`, rungs 4–5 run `n` repeats from configuration, rungs 3 and 6 run once — each rung recording its own `observed_runs` and `reproduced_runs` on `rung_attempt` (R-04, R-18, quickstart 19, 21)
- [ ] T053 **Test** [US3] Search the engine for any threshold on `observed_rate`; none exists — this feature carries the rate and does not judge it (R-04, 008 FR-013, quickstart 20)
- [ ] T054 [P] [US3] Continuous check `check:no-pass-laundering` — a timeout, a build failure, an unparseable report and an absent report never appear as `PASS` (SC-006)

---

## Phase 6: US4 — The sandbox is hostile to what it runs (P1)

**Goal**: default-deny egress as an absent route, no credentials, and a workspace destroyed by the runtime rather than by code.

**Independent test**: quickstart 29–45

- [ ] T055 **Test first** [US4] The red-team fixture suite — egress, credential probe, fork bomb, hang, shared-path write — every attempt denied or bounded, the run terminating within limits, and the run record carrying the recorded egress posture, the prefetch denials and every bound that fired (SC-003, SC-004, R-19, quickstart 32)
- [ ] T056 [US4] Two containers per run: a **prefetch** container whose network namespace reaches the package-registry allowlist only, built into the image at build time, writing the dependency cache; and a **run** container with **no default route and no DNS**, the cache mounted read-only (R-08, FR-011)
- [ ] T057 **Test first** [US4] A test opens a socket to the internet → `connect()` fails at the syscall; a test resolves a hostname → no resolver is reachable (R-08, quickstart 29, 30)
- [ ] T058 **Test first** [US4] Inspect both containers: the allowlist exists only at image-build time for prefetch, and the run container has **no run-time egress configuration to misconfigure** (FR-011, quickstart 31)
- [ ] T059 [US4] `egress_denial` rows for the **prefetch phase only**, carrying host or address and never a payload — `phase` has no `run` member, because `connect()` is not intercepted (R-19) — plus `execution_run.egress_posture` written by the supervisor on every run: route table empty, resolver absent, allowlist digest. That posture is what SC-003 checks in production (R-08, R-19, FR-011)
- [ ] T060 [US4] Container limits taken from the run's `sandbox_profile` version — CPU, memory, processes, open files, disk, wall clock — killing the **entire process tree** on breach (FR-010)
- [ ] T061 **Test first** [US4] A test that never terminates → the process tree is killed at the wall clock, `exit_status = timeout`, mapped to `INCONCLUSIVE` and **never** `PASS` (FR-016, quickstart 35)
- [ ] T062 [US4] Credential scan before the run over environment, mounted paths and checkout, and after the run over what the workspace produced; a `hit` aborts **before the checkout is readable** (R-09, FR-012, quickstart 34)
- [ ] T063 **Test** [US4] Inspect the run environment: no production credential, no repository write credential, no tenant secret (FR-012, quickstart 33)
- [ ] T064 [US4] Workspace as a tmpfs mount **inside** the run container, so container exit destroys it on every path — success, test failure, timeout kill, crash, node eviction. No `finally` block owns destruction (R-07, FR-014)
- [ ] T065 **Test first** [US4] Inspect the filesystem after success, after failure and after a SIGKILL mid-run; the workspace survives none of them and the next run starts fresh (FR-014, R-07, quickstart 36, 37)
- [ ] T066 [US4] Reconciliation job asserting no workspace outlives its run's grace period; leave one behind artificially and assert it is reported (SC-005, quickstart 38)
- [ ] T067 **Test first** [US4] A test writes to a mounted path and to the shared dependency cache → denied, the cache is read-only, and the denial is **recorded rather than silently tolerated** (spec edge case, quickstart 39)
- [ ] T068 [US4] Per-tenant dependency cache volume, even where the contents would be byte-identical (R-09, FR-030, quickstart 40)
- [ ] T069 **Test first** [US4] Model-generated code tries to reach the control plane → refused; the only path out is the structured result contract, and the sandbox holds no credential, socket or route (R-15, quickstart 41)
- [ ] T070 **Test** [US4] Exactly two declared, schema-validated, permission-checked and audited tools — `runReproduction(directive)` and `runTests(selector)`. **There is no shell** (FR-028, R-15, quickstart 42)
- [ ] T071 [US4] Capacity queuing: a run beyond the runner's declared `maxConcurrentRuns` persists as `state = queued` with a bounded wait deadline; **no worker job holds the position**, and queue depth per tenant is a metric (R-12, 012 FR-025, quickstart 43)
- [ ] T072 **Test first** [US4] Fail infrastructure and retry → a new `execution_run` id, `superseded_by` set on the old row, and **no query aggregating `test_result` across execution identifiers** (FR-013, R-13, quickstart 44)
- [ ] T073 [US4] Environment recording: resolved commit sha, base image digest, lockfile digest — generated by prefetch where the repository has none — and the resolved dependency version list, so a divergent re-run is explainable rather than mysterious (FR-015, R-14, quickstart 45)
- [ ] T074 [P] [US4] `GET /reproduction/executions/{executionId}` and `/test-results` (openapi)
- [ ] T075 [P] [US4] Continuous check `check:workspace-destroyed` (SC-005)
- [ ] T076 [P] [US4] Continuous check `check:credential-scans` — every run has a clean pre-run scan (SC-004)

**Checkpoint**: the component that runs untrusted code over the customer's source tree has been watched to deny everything it must deny.

---

## Phase 7: US5 — Reproducing a data bug without taking the data (P2)

**Independent test**: quickstart 46–53

- [ ] T077 **Test first** [US5] Search the schema for fixture contents, in any column and any construction mode; assert none exists (C-04, R-06, quickstart 51)
- [ ] T078 [US5] `reproduction_fixture` as metadata only — rung, construction mode, content digest, scan result, grant reference, recipe, lifecycle timestamps — with **no contents column** (C-04, R-06)
- [ ] T079 **Test first** [US5] Reproduce a `data`-rung defect from request shape, then scan the fixture for any value copied from the source record; none is found (US5, SC-010, quickstart 46)
- [ ] T080 [US5] Fixture construction in fixed order, stopping at the first that reproduces: `request_shape` → `synthetic` → `anonymised`. The order is a DPA commitment and is **never reordered** (FR-024, ladder contract, quickstart 47)
- [ ] T081 **Test first** [US5] Request an anonymised extract with no tenant grant → refused with `GRANT_REQUIRED`; `grant_ref` is a not-null constraint in that mode (FR-024, quickstart 48)
- [ ] T082 **Test first** [US5] Attempt to copy a raw production payload into a fixture in each of the three modes → refused in every one (FR-024, quickstart 49)
- [ ] T083 [US5] Fixture scanner for secret and personal-data patterns before use; a detection sets `scan_result = blocked`, prevents use and raises the finding (FR-025, quickstart 50)
- [ ] T084 [US5] What crosses to 008 is the **recipe**, not the data: the field presence/type/bound descriptor for `request_shape`, the generator parameters and seed for `synthetic` — no values (R-06, quickstart 52)
- [ ] T085 **Test first** [US5] Reproduce only via an anonymised extract → `recipe` is null, and the handoff states that 008 attempts a synthetic equivalent and takes its `NO_RECIPE` off-ramp to a human if that does not reproduce (R-06, C-23, 008 FR-011a, quickstart 53)
- [ ] T086 [P] [US5] Continuous check `check:fixture-contents` — no fixture contents anywhere, in any mode (SC-010, C-04)

---

## Phase 8: US6 — Running an arbitrary project's tests (P2)

**Independent test**: quickstart 54–62

- [ ] T087 **Test first** [US6] Search every adapter for a stdout parser; assert none exists, and that an adapter unable to obtain a machine-readable report declares the repository **`unsupported`** rather than falling back (R-10, [contracts/test-runner-adapter.md](contracts/test-runner-adapter.md), quickstart 55)
- [ ] T088 [US6] Adapter interface as three separately recorded steps — `discover`, `invoke`, `parse` — each with its own recorded outcome, because they fail for different reasons and route differently (FR-018, adapter contract)
- [ ] T089 [US6] File-based deterministic detection: no model participates in choosing an adapter, and two runs over the same tree resolve identically (adapter contract)
- [ ] T090 [US6] Command template injecting a machine-readable reporter flag, with the report path inside the workspace so it dies with it; `runner_adapter_resolution` records the command **actually run**, not the template (FR-018, R-10, quickstart 54)
- [ ] T091 **Test first** [US6] Corrupt the report file, then truncate it mid-file → `INCONCLUSIVE` / `unparseable_output` with the parse failure as evidence, and never "zero tests" (FR-019, quickstart 56, 58)
- [ ] T092 **Test first** [US6] Exit non-zero with no report → recorded differently from parsed failing tests, by keeping `report_present` and `parse_outcome` as separate facts (FR-020 edge case, quickstart 57)
- [ ] T093 **Test first** [US6] A selector matching nothing with a present, well-formed report → zero results and `INCONCLUSIVE`, never `PASS` (FR-019, quickstart 59)
- [ ] T094 [US6] Tenant-declared command fallback, which must also declare a report path and format; a tenant command without one is treated as unsupported (FR-020, quickstart 60)
- [ ] T095 **Test first** [US6] Unsupported runner with nothing configured → `INCONCLUSIVE` / `no_test_command`, naming the missing configuration (FR-020, quickstart 61)
- [ ] T096 [US6] `test_result` rows carrying test identifier, file, status, duration, a bounded failure message and a `failure_signature` normalised by the **issue's** ruleset version, so the equality check compares like with like (FR-018, adapter contract, 001 FR-011)
- [ ] T097 [US6] `make adapter-conformance`: all eight fixtures for every registered adapter, and an adapter without a conformance suite **is not registered** (adapter contract, quickstart 62)

---

## Phase 9: US7 — The expensive tests run somewhere else (P3)

**Independent test**: quickstart 63–68

- [ ] T098 **Test first** [US7] Require a full suite and assert **no worker job is in a running state** while the delegation is `requested` or `running` (FR-021, FR-022, SC-011, quickstart 63)
- [ ] T099 [US7] `ci_delegation` as a persisted waiting state plus a `workflow_callback` of kind `ci_result` with a token hash and an expiry (R-11, FR-022, 012 T014)
- [ ] T100 [US7] `POST /reproduction/ci-delegations/{delegationId}/callback` ingesting results as `test_result` evidence correlated to the requesting execution and carrying the external CI run identifier, then publishing `CiResultsReceived` — the event 008 resolves `awaiting_ci` on (FR-023, [contracts/events.md](contracts/events.md), 008 R-24, quickstart 64)
- [ ] T101 **Test first** [US7] Deliver the same callback twice → `received_count` increments and nothing else changes (FR-022, quickstart 65)
- [ ] T102 [US7] Deadline resolution through the workflow run's `deadline_at` tick: a callback that never arrives becomes `timed_out` and routes to a human, never an indefinite wait (R-11, FR-022, 012 T013, quickstart 66)
- [ ] T103 **Test first** [US7] Induce a twenty-minute pipeline and assert the longest worker job stays inside its declared wall clock (SC-011, 012 FR-027, quickstart 67)
- [ ] T104 [US7] Scope split: unit-scope tests execute in the sandbox; full suite and e2e are delegated (FR-021, D-16, quickstart 68)
- [ ] T105 [P] [US7] `GET /reproduction/ci-delegations/{delegationId}` (openapi)
- [ ] T106 [P] [US7] Continuous check `check:no-blocked-jobs` — no worker running while a CI delegation is pending (SC-011)

---

## Phase 10: Boundary and tenancy

- [ ] T107 **Test first** Attempt to transmit a raw log body, a source file and a fixture payload across the plane boundary; each is rejected by the boundary schema contract test (FR-026, SC-009, 012 T040, quickstart 69)
- [ ] T108 **Test** The evidence transmitted for an egress denial is a `tool_output_summary`, not a new top-level shape (R-17, quickstart 70)
- [ ] T109 [P] e2e isolation matrix: another tenant's execution, ladder record, fixture record and delegation all return **404** (SC-012, quickstart 71)
- [ ] T110 [P] **Test first** Replay a delegation callback with another tenant's token → 404, never 403 — a 403 confirms existence (SC-012, quickstart 72)
- [ ] T111 [P] **Test** A month-old run's evidence links, `agent_run` and tool calls all resolve (FR-029, 012 FR-033, quickstart 73)

---

## Phase 11: Polish

- [ ] T112 [P] Regenerate `contracts/openapi.json` from the controllers and check for drift; hand edits fail (012 FR-010)
- [ ] T113 [P] SC-007 determinism check: repeating a reproduction at the same commit for a deterministic class yields the same rung and the same result in ≥ 99% of repeats
- [ ] T114 [P] `make eval -- --metric reproducible-share` and `--metric rung-distribution`; a fall below the stage-0 threshold is reported as a scope signal, not a bug, and real and synthetic incidents are never combined into one figure (SC-008, C-05)
- [ ] T115 Run the whole of [quickstart.md](quickstart.md) — all 74 scenarios including the hostile ones, plus all 7 continuous checks

---

---

## Phase 12: Two ladders and the client rungs (P1)

**Independent test**: quickstart client-ladder scenarios

- [ ] T116 **Test first**: a directive with `observableLocation = client` attempted on the server ladder must fail the test — `unit` and `request` cannot produce a `FAIL` for a client-only observable in principle (FR-002a, R-22)
- [ ] T117 `ladder_rung` gains `ladder` and `requires_declared_reason`; unique `(ladder, rung_order)` and `(ladder, key)`; both ladders seeded as reference data (FR-002, R-22)
- [ ] T118 Ladder selection from the directive's `observable_location`; `undetermined` → `INCONCLUSIVE` with reason `observable_location_undetermined` (FR-002a, R-22)
- [ ] T119 `client_unit` rung: component or store invoked in the project's test runner, **no browser, no build** — the rung that catches a state machine never leaving `loading` (FR-002, R-22)
- [ ] T120 `client_request` rung: replay the recorded failing request against the client's handling, no browser. Reached whenever intake captured a trace identifier, a HAR or a console log (FR-002, R-22)
- [ ] T121 `client_journey` rung: Playwright against a locally served build, backend local or stubbed because the sandbox has default-deny egress (FR-002, R-19, R-23)
- [ ] T122 **Test**: `client_journey` is refused when a cheaper rung on its ladder was never attempted, and refused with `browser_unavailable` when the runner image carries no browsers (FR-002b, R-23)
- [ ] T123 [P] Browsers and the frontend build toolchain in the runner image, behind a declared capability so a runner without them degrades explicitly rather than failing mid-run (FR-002b, 012 C-02)
- [ ] T124 Product floor under the per-rung repeat counts: literal plus constant plus a **test first** that a configuration write below the floor is refused. One flaky `PASS` at a repeat count of one is a false reproduction carrying the regression test, the fix verdict and the false-fix rate on top of it; rung timeouts and sandbox resource limits ship starting values chosen to fail closed (FR-031, [stage 0 S0-7](../../docs/stage-0.md))

## Dependencies

```text
012 phases 1–2 ──┐
012 phase 6 ─────┼─▶ Phase 1 ──▶ Phase 2 ──┬─▶ Phase 3 · US1 (T018–T030)
006 phase 9 ─────┤   (runner + T040/T043)   ├─▶ Phase 4 · US2 (T031–T042) ← needs T023
001 phase 2 ─────┘                          ├─▶ Phase 5 · US3 (T043–T054)
                                            ├─▶ Phase 6 · US4 (T055–T076)
                                            ├─▶ Phase 7 · US5 (T077–T086) ← needs Phase 6
                                            ├─▶ Phase 8 · US6 (T087–T097) ← needs Phase 6
                                            └─▶ Phase 9 · US7 (T098–T106)
                        Phase 10 (T107–T111) ◀── needs T014 and any executing phase
Phase 11 (T112–T115) last
```

**Explicit dependencies beyond phase order**

- **Phase 6 blocks Phases 7 and 8 in practice**, although the phase graph does not require it: a
  fixture (T079) and an adapter invocation (T090) both need a run container that exists, has limits
  and destroys its workspace. Building either against an unisolated container produces tests that
  pass for the wrong reason.
- T023 (signature equality) is a prerequisite for the whole of Phase 4: a climb that cannot decide
  `reproduced` has no stop rule. Land it before T031.
- T019 (`change_eligibility`) composes with 006's `fix_eligibility`. T021 cannot run until 006's view
  exists; write the test first and let it fail for want of the other view.
- T050 (`capability_refused`) depends on 012 T043's capability resolution and refusal. Until a runner
  can refuse, the reason is unreachable and its test is red — which is the correct state, not a gap.
- T026 needs 005's adopted expectations for the third of its three assertion sources. The first two —
  observed signature and violated contract — are available from 001 and 003, so the task lands with
  those and the third is enabled when 005 does.
- T030 (`check:change-gate`) and T086 (`check:fixture-contents`) reconcile against 008's change plans
  and regression tests; write both here and enable them in `ci` when 008 produces something to
  reconcile.
- T059 needs nothing from the container runtime on the run-container side: there is no interception to
  depend on (R-19). What it needs is the supervisor's read of the namespace — route table and resolver
  — at run start. Where even that read fails, `egress_posture` records the failure rather than an
  assumed-clean posture, and SC-003's check treats it as unverified, never as passed.
- T098 and T106 both assert the same property from two sides: one in a test, one continuously. Land
  T098 first so the check has a known-good shape to reconcile against.

## Parallel groups

- Setup: T002–T006 together; T007 after them.
- Foundational: T014–T017 after T010–T013.
- US1: T029, T030 after T019.
- US2: T040, T041, T042 after T032–T039.
- US4: T074, T075, T076 after T064–T073 — separate files, separate checks.
- The seven continuous checks — T030, T042, T054, T075, T076, T086, T106 — are seven independent
  scripts and parallelise completely once their subject tables exist.
- Boundary and tenancy: T109, T110, T111 together.
- Polish: T112, T113, T114 together.

## Strategy

1. **Phase 2 before anything, and T012 in particular.** The climb has to be a sequence of short jobs
   from the first rung that ever runs. Building it as one long job and splitting it later means every
   wall-clock budget, every retry and every queue behaviour is rewritten — and "never wait inside a
   job" is the constraint that keeps BullMQ sufficient instead of needing a workflow engine.
2. **Phase 3 is the MVP and it is the point of the feature.** `change_eligibility` plus signature
   equality is what makes constitution III structural. It ships before the ladder is complete: a
   single-rung engine with a correct gate is safe, while a six-rung engine with a writable flag is not.
3. **T023 before T031, and signature equality before the ladder.** A `FAIL` that means "something
   failed" rather than "this failed" opens the change path on a defect that was never reproduced —
   the most expensive lie the system can tell. The stop rule is meaningless until the match is exact.
4. **Phase 6 before Phases 7 and 8, out of priority order.** US4 is P1 and the two P2 stories run
   inside what it builds. Fixture construction and adapter invocation inside a container that does not
   yet deny egress would both be tested against a sandbox that is not one, and the tests would pass.
5. **T056 (two containers) before any other sandbox work.** Default-deny as an absent route is an
   image and namespace property. Starting with one container and an allowlist, intending to split it
   later, means the run container has a route during the whole period in which the hostile fixtures
   are being written — and the fixtures would be written to pass against a filter.
6. Phase 5 (US3) alongside Phase 4: the ladder and the honest outcome are two halves of one record,
   and building the climb without the ten reasons produces an engine whose only failure mode is
   "did not reproduce".
7. Phase 9 (US7, P3) last of the stories. CI delegation removes most of the secrets problem from the
   sandbox, but nothing else waits on it, and it needs 012's callback registry to be settled rather
   than new.
8. Phase 11 last, and T115 is not optional: the majority of the 73 scenarios assert that something
   does **not** happen — a connection not made, a workspace not surviving, a `PASS` not recorded. A
   denial that has never been executed is a claim.
