# Tasks: Regression suite

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/selection.md](contracts/selection.md),
[contracts/openapi.yaml](contracts/openapi.yaml), [quickstart.md](quickstart.md)

**Tests**: TDD is constitutional. Every task that adds behaviour starts with the quickstart scenario it
names, watched to fail.

**Organization**: one phase per user story. US1–US3 are P1 and form the MVP: adopted expectations
become tests, changes run them, failures become issues.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [ ] T001 Package `packages/domain/regression` and `packages/agents/test-author` with entry surfaces (012 FR-001)
- [ ] T002 [P] Prisma models for schema `regression` per [data-model.md](data-model.md) — `test_binding`, `suite_run`, `selection_request` (append-only rule); `tenant_id` and `(tenant_id, …)` indexes; first migration and its reverse (012 FR-048, FR-049)
- [ ] T003 [P] `make regression-fixtures`: a fixture repository with an OpenAPI document, expectation documents, annotated tests, and a 004 graph with components, endpoints and one `flow`

---

## Phase 2: Foundational — cross-feature additions

Each is raised against its owner and lands in the owner's package.

- [ ] T004 005: parse `subject`, `given`, `when`, `then`, `priority` per `expected_behaviors` entry into the expectation version; a document without them parses unchanged. **Test first** with both (FR-002, 005 R-08 extension, R-01)
- [ ] T005 [P] 012: `test_binding_ref` in the closed boundary schema set; free-form fields rejected (012 FR-022, runner protocol)
- [ ] T006 [P] 012: `agent_kind = test_author` in `agent_run`; `agent_directive` accepts it (012 data model, R-07)
- [ ] T007 [P] 001: a normalisation ruleset version whose regression signature is binding identifier plus environment. **Test first** — five failures of one binding, one fingerprint (R-08)
- [ ] T008 [P] 002: a test pull request evaluated as the same action class as 008's pull request; no new autonomy level (R-07)

---

## Phase 3: US1 — Only an adopted expectation becomes a test (P1)

**Independent test**: quickstart 1–6.

- [ ] T009 [US1] **Test first** — quickstart 1 and 3: a test request for a draft expectation, and for one whose approval came from Healer's identity, is refused and recorded (FR-007, 005 R-17)
- [ ] T010 [US1] `RequestTest` command: resolves the expectation version, requires an active `anchor_grant`, emits an `agent_directive` of kind `test_author` (FR-007, R-07)
- [ ] T011 [US1] Runner: annotation scanner reading `@expectation <id>@<version>` and the constraint keys each test references; emits `test_binding_ref` (R-06)
- [ ] T012 [US1] **Test first** — quickstart 4: a test referencing no constraint key of its expectation is refused as vacuous (FR-008, R-07)
- [ ] T013 [US1] Runner: `packages/agents/test-author` — chooses the lowest 007 rung that observes the subject, writes the annotated test, runs it on the default branch in the sandbox; `client_journey` only with a declared reason (FR-009, C-25)
- [ ] T014 [US1] **Test first** — quickstart 5 and 6: passing → test pull request naming expectation, version and adopting human; failing → no pull request and one `automated_detection` issue with the result as evidence (FR-010, SC-006)
- [ ] T015 [US1] Binding reconciliation: `test_binding` rows from `test_binding_ref`, keyed by `(tenant, repository, test_identifier)`; a test no longer reported moves to `retired`; a binding cannot become `active` without an active `anchor_grant`, checked continuously (R-06, SC-001, quickstart 18)
- [ ] T016 [US1] The test author's credential creates pull requests only; merge is absent from its tool set and from the API (FR-011, 008 T093 layer pattern)

---

## Phase 4: US2 — Every change runs the scenarios it can affect (P1)

**Independent test**: quickstart 9, 10, 20.

- [ ] T017 [US2] **Test first** — quickstart 9 and 10: closure selection, unknown path and uncomputable closure (FR-013, SC-003)
- [ ] T018 [US2] `POST /regression/selection` per [contracts/selection.md](contracts/selection.md): path → component (004), impact closure, flows through the closure, active bindings; a `selection_request` row on every branch
- [ ] T019 [US2] CI credential scoped to selection for one tenant; tenant-isolation e2e test (quickstart 20, 012 FR-013)
- [ ] T020 [P] [US2] The CI step for the customer's pipeline — GitLab CI template for the design partner and GitHub Actions for Healer's own repository (C-42): writes the test list or `FULL_SUITE`, and falls back to `FULL_SUITE` on timeout, error or unreachable Healer, printing the reason; the suite is executed by the customer's CI only (FR-012)

---

## Phase 5: US3 — A failing scenario is an issue (P1)

**Independent test**: quickstart 11–14, 19.

- [ ] T021 [US3] Observed runs: a pipeline event from the CI adapter records a `suite_run` idempotently on `(tenant, ci_run_id)` and issues a collection directive; Healer has no operation that runs the suite against a live environment (FR-012, R-05)
- [ ] T022 [US3] Runner: fetch the run's machine-readable report and parse it with 007's adapters into `test_result` evidence linked to the `suite_run`; report contents never cross (FR-014, R-05, 007 R-10)
- [ ] T023 [US3] **Test first** — quickstart 11–14: the failure-to-issue rule — `regression` on the default branch after a pass, `automated_detection` if never passed, nothing on a pull-request branch, grouping by fingerprint, fan-out above 10 as one incident; the issue exists within 5 minutes of the result arriving (FR-015, FR-016, FR-017, R-08, SC-004)
- [ ] T024 [US3] The `regression` issue carries the bound expectation version as candidate anchor; eligibility stays with 006–008 (FR-018)
- [ ] T025 [US3] **Test** — quickstart 19: planted markers in a failing test's message and in a test file are absent from every control-plane table, log, trace and payload (012 SC-011, ADR 0010)

---

## Phase 6: US4 — Drafts without drowning the reviewer (P2)

**Independent test**: quickstart 2, 7, 8.

- [ ] T026 [US4] Runner: deterministic API drafting from OpenAPI — one draft per operation and documented response code, no model call (FR-003, SC-002, quickstart 7)
- [ ] T027 [US4] Runner: model-proposed page and journey drafts from routes, components, 004 `flow` nodes and existing end-to-end tests, as `machine_generated` with seeding sources (FR-004, ADR 0010)
- [ ] T028 [US4] Drafts delivered as a pull request against the expectation documents; approving it is adoption per 005 R-16; the per-component cap counts draft expectations in open draft pull requests (FR-002, FR-005, R-02, quickstart 2 and 8)
- [ ] T029 [US4] Batch ordering by incident history and blast radius (FR-006)

---

## Phase 7: US5 — Coverage shows the gaps (P2)

- [ ] T030 [US5] **Test first** — a quarantined binding counts as uncovered (FR-023, SC-005)
- [ ] T031 [US5] `GET /regression/components/{id}/coverage` and `/bindings`, computed at read time from 004, 005 and `test_binding`; tenant-isolation tests (FR-023, FR-024, R-09)
- [ ] T032 [US5] Quarantine per 008 FR-013 applied to bindings; a quarantined binding's failures create no issues; the third quarantine of one binding routes to a human (FR-019, quickstart 15)

---

## Phase 8: US6 — A deliberate behaviour change is a human decision (P3)

- [ ] T033 [US6] A newly adopted version marks bound tests `stale` and requests a test pull request against it (FR-020, quickstart 16)
- [ ] T034 [US6] A change set editing a bound test's assertion with the expectation version unchanged is a masking candidate in 008's analyser (FR-021, quickstart 17)
- [ ] T035 [US6] Retirement: a retired expectation's bindings are removed by pull request and create no issues from retirement onward (FR-022)

---

## Phase 9: Polish

- [ ] T036 Dashboard coverage view per component, and the `regression` issue's link to its binding and expectation
- [ ] T037 [P] Measure median engineer review time per draft on the design partner's first draft pull requests and report it against S0-5; a breach lowers the draft cap (SC-007, FR-005)
- [ ] T038 [P] Runbook `docs/runbooks/regression-suite.md`, indexed in `docs/README.md`: adding the CI step, reading coverage, what a `FULL_SUITE` reason means

## Dependencies

```text
Phase 1 → Phase 2 (T004–T008) → US1 (T009–T016) → US2 (T017–T020) ─┐
                                     └──────────→ US3 (T021–T025) ──┴→ US4 → US5 → US6 → Polish
```

- Needs 012 T093 (runner-side inference) for T013 and T027; 007's report adapters for T022; 004's
  impact closure and repository mapping for T018; 008's masking analyser for T034.
- US2 and US3 can proceed in parallel once US1's bindings exist.

## Parallel groups

- Phase 2: T005–T008 together.
- US2: T020 alongside T018–T019.
- US4: T026 and T027 together.

## Strategy

1. **MVP is US1 + US2 + US3**: adopted expectations become tests, pull requests run the ones they can
   affect, and default-branch failures become issues. Without US3 it is a test generator; without US2
   it finds regressions a day late.
2. **API before pages.** T026 costs no model call and covers the most surface; page and journey
   drafts come after the adoption rate on API drafts is known (S0-5).
3. **Healer's own repository first** (C-42): the GitHub step and Healer's own OpenAPI documents are the
   first fixture that is not synthetic.
