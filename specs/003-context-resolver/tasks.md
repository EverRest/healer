# Tasks: Context resolution across the hybrid boundary

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/openapi.yaml](contracts/openapi.yaml),
[contracts/collection-plan.md](contracts/collection-plan.md), [quickstart.md](quickstart.md)

**Prerequisites**: [012](../012-engineering-foundation/tasks.md) phases 1–2 — workflow machine,
callback registry, outbox, tenancy context, runner registration and capability resolution, plus the
closed boundary schema set (012 T040) this feature conforms to and does not extend.

**Tests**: TDD is constitutional (Development Workflow), not optional. Every boundary refusal —
nothing raw crossing, withholding over truncation, ingress quarantine, the unrepresentable collector
— gets a test that is **seen to fail first**. A boundary nobody has watched refuse something is a
boundary nobody knows is there.

**Organization**: one phase per user story. US1–US3 are P1; US1 is the product's licence to operate.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 Packages `packages/domain/context` (control plane) and the `apps/runner/src/collection` module (execution plane) with their entry surfaces (012 FR-001)
- [x] T002 [P] Prisma models for schema `context` per [data-model.md](data-model.md) — `context_snapshot`, `collection_pass`, `source_outcome`, `context_item`, `collection_ruleset`, `ranking_ruleset`, `redaction_ruleset`, `collector_registration`, `boundary_rejection`; first migration
- [x] T003 [P] The plane-local `withholding_ledger` inside the runner, on the customer's storage and their retention; **never replicated to the control plane** and absent from the control-plane schema (R-08, FR-009)
- [x] T004 [P] Database rules rejecting `UPDATE` and `DELETE` on `context_snapshot`, `collection_pass`, `source_outcome`, `boundary_rejection` and the three ruleset tables (FR-022)
- [x] T005 [P] `packages/integrations/{loki,prometheus,grafana,otel,gitlab,config-flags}` adapter skeletons — the constitution's v1 set and nothing beyond it; a source the design partner does not operate is absent from the plan, not a failing collector (spec assumptions)

---

## Phase 2: Foundational (blocks every story)

**Purpose**: one boundary schema validated twice, and a type that makes collected text unable to
reach a decision.

- [x] T006 `packages/boundary-contract` extended with the `collection_plan` directive and result-batch shapes of [contracts/collection-plan.md](contracts/collection-plan.md); it conforms to 012's closed evidence shape set and **adds nothing to it** (R-02, R-03, 012 T040)
- [x] T007 **Test first**: post a result batch carrying a free-form string field → `422 BOUNDARY_SCHEMA_REJECTED` at ingress, and the same payload refused at egress on the runner before it is sent (FR-010, SC-002, quickstart 33) **Built at the ingress-function level** (`acceptResultBatch` → `BOUNDARY_SCHEMA_REJECTED`/422 error); the HTTP route is T046.
- [x] T008 Egress validation on the runner and independent ingress validation in the control plane, both executing the **one** schema package — two executions, one definition (R-02, FR-010)
- [x] T009 `Untrusted<string>` branded type for every excerpt; the planner, the ranker and the dedup key builder have no parameter that accepts it (FR-021, R-11)
- [x] T010 **Test first**: pass a collected excerpt into 002's `DecisionInput`, into a ranking term and into a tool argument → none compiles, because no accepting parameter exists (FR-021, quickstart 26, 002 FR-003)
- [x] T011 `domain/collector-registry.ts` and `collector_registration`: declared collectors with their parameter schemas, item classes, default timeout and required capability; `collectorKey` is an **enum over the registry, never a string** (FR-005, R-12) **Registry and `collector_registration` sync built; no reader yet** — `GET /context/collectors` is T077.
- [x] T012 `domain/gap-reasons.ts`: the closed reason-code set — `source_unreachable`, `auth_revoked`, `timeout`, `retention_exceeded`, `capability_unavailable`, `budget_exhausted`, `redaction_withheld`, `schema_rejected`, `empty_result` (R-07, contracts/collection-plan.md)
- [x] T013 [P] Tenant scoping on every repository method and every collector invocation; a query built without `TenantContext` fails to type-check (FR-023, 012 T010)
- [x] T014 [P] Outbox publishers for the events in [contracts/collection-plan.md](contracts/collection-plan.md) (012 T012)
- [x] T015 [P] One audit entry per collection pass recording the plan, the ruleset versions, the per-source outcomes, the transmitted and withheld counts and the contract version (FR-027, quickstart 47) **Audit builder built, not yet persisted** — written with the pass by `IngestResultBatch` (T036).

**Checkpoint**: the boundary is defined once and enforced on both sides; collected text cannot reach a predicate.

---

## Phase 3: US1 — Nothing raw crosses the boundary (P1) 🎯

**Goal**: a security reviewer can read the list of what may cross and check it against what does.

**Independent test**: quickstart 3, 4, 5, 6, 7, 8, 9, 33, 34, 35, 43, 46

- [x] T016 **Test first**: `make context-marker-corpus` — seed logs, traces and config with known PII markers and secrets, run a full collection, inspect **every crossed byte** → 0 markers present (FR-007, SC-001, quickstart 3)
- [x] T017 `redaction_ruleset` as immutable versioned detectors published in the control plane and applied **only** in the execution plane; the version is recorded on the snapshot and on every item it touched (FR-008, data-model) **Definition and runner-side application built; the control-plane `redaction_ruleset` table is not populated** (no reader until a snapshot records it, T040).
- [x] T018 The redactor in `apps/runner/src/collection/redaction` implementing T016 against the published ruleset version (FR-008)
- [x] T019 **Test first**: a log format the redaction ruleset does not recognise → the item is **withheld** with a `collection_gap` carrying `redaction_withheld`, and is never truncated and sent (FR-009, SC-003, quickstart 7, 012 R-05)
- [x] T020 `withholding-ledger.ts` implementing T019: the original stays plane-local under a fresh UUID and what crosses is `{ localRef, itemClass, reasonCode, collectorKey, observedAt }` — no excerpt, no locator we can follow, no truncated remnant (FR-009, R-08)
- [x] T021 **Test first**: take a `localRef` from a withheld gap and try to resolve it from the control plane → **no path exists**; the control plane holds a reference it is structurally unable to dereference (R-08, quickstart 8)
- [x] T022 `make runner-resolve-ref <uuid>`: the resolution path for a human **inside the customer's network**, against the plane-local ledger only (FR-009, R-08, quickstart 8)
- [x] T023 [P] **Test first**: collect configuration and feature flags → key names, value types and change indicators only; no value contents cross in any form (FR-007, quickstart 4)
- [x] T024 [P] `config_flags` collector implementing T023, emitting `config_key_ref` — its own declared shape, never `tool_output_summary` (C-20, contracts/collection-plan.md crosswalk)
- [x] T025 [P] **Test first**: run a full collection over a repository → file paths, symbol names and line numbers only; no file content crosses in bulk (FR-011, quickstart 5)
- [x] T026 `source_file` collector reachable **only** as a follow-up pass, so named-file retrieval inherits the cap, the schema validation and the audit entry rather than being a second mechanism (FR-011, R-12, quickstart 6)
- [x] T027 [P] **Test**: an excerpt that survives redaction carrying no remaining signal is **kept** with its structured derivatives and `redactionDominated: true`, not withheld — so a reader knows to look locally rather than concluding there was nothing there (R-08, quickstart 9)
- [x] T028 [P] **Test**: a 40 MB heap dump → a bounded redacted excerpt plus a plane-local reference; the full payload never crosses and never inlines (FR-013, quickstart 43, 001 FR-011)
- [x] T029 `QuarantineRejection`: `boundary_rejection` rows carrying contract version, runner identifier, schema error paths, payload digest and byte size — **the payload is not stored anywhere** (FR-010, R-13, quickstart 34)
- [x] T030 [P] `GET /boundary-rejections` — rejections and their counts visible to the tenant (FR-010, quickstart 35)
- [x] T031 [P] `check:no-payload-at-rest` — no `boundary_rejection` row carries payload content (R-13)
- [x] T032 [P] **Test**: search control-plane configuration for a credential to any customer observability, repository, configuration or deployment system → none exists (FR-002, quickstart 46)

**Checkpoint**: the hybrid split has bought what it was built to buy. This is the phase the procurement conversation depends on.

---

## Phase 4: US2 — One snapshot, collected in parallel, before anything reasons (P1)

**Independent test**: quickstart 1, 2, 10, 11, 36, 37, 38, 39, 40, 48

- [ ] T033 **Test first**: dispatch a pass with one artificially slow source → wall-clock within 2× the slowest single source and flat in source count, not their sum (FR-003, SC-006, quickstart 2)
- [ ] T034 `pool.ts`: bounded concurrent fan-out **inside the runner** with a per-source timeout; one directive out, one result batch back, so the control plane addresses no collector and holds no credential (FR-003, R-06)
- [ ] T035 `DispatchPass`: one `collection_pass` row, a persisted wait on the workflow machine and one `runner_result` callback — no job waits for the runner inline (FR-025, 012 T013, T014)
- [ ] T036 `IngestResultBatch`: ingress validation, then one `evidence` record per item with the collection step as its producing step, and one `context_item` view over it that duplicates no fact (FR-012, 001 T005, T006)
- [ ] T037 [P] **Test**: inspect the evidence links the collection step wrote → `produced_by_step` is the collection step, not a later one (FR-012, quickstart 11, 001 FR-008)
- [ ] T038 **Test first**: deliver the same result batch twice → the second returns `duplicate: true` and writes no duplicate evidence records, so occurrence counts are not inflated (FR-026, quickstart 38)
- [ ] T039 Pass idempotency keyed on `(issue_id, plan_digest, pass_ordinal)` implementing T038 — the plan digest is already the content hash, so no second key exists to disagree with the first (FR-026, R-05)
- [ ] T040 `FinaliseSnapshot`: `finalised_at` set once, with the collection window, runner version and every ruleset and contract version recorded (FR-001, FR-022)
- [ ] T041 **Test first**: add an item to a finalised snapshot → rejected; re-collection creates version n+1 with the predecessor still readable (FR-022, quickstart 39)
- [ ] T042 **Test first**: create an issue with no runner registered → the pass is held `runner_unavailable`, the issue shows context **pending, not empty**, and no job waits (FR-025, quickstart 36)
- [ ] T043 `IssueDetected` and `IssueReopened` consumers — pass 0 on detection, a new snapshot version linked to its predecessor on reopen — and `RunnerRegistered` / `RunnerStatusChanged` consumers dispatching passes held as `runner_unavailable` (contracts/collection-plan.md, FR-022)
- [ ] T044 **Test first**: dispatch a pass and never deliver a result → the deadline tick finalises the snapshot with every planned source `not_attempted` and its gap record (quickstart 37, 012 T013)
- [ ] T045 [P] **Test**: runner and source clocks five minutes apart → window selection uses the source's observed time and the collection timestamp is the runner's (FR-001, quickstart 40)
- [ ] T046 [P] `POST /runner/collection-results` — the inbound half of the persisted wait (FR-025)
- [ ] T047 [P] `GET /issues/{issueId}/context`, `/context/versions`, `GET /context-snapshots/{id}`, `/items`, `/passes` (FR-001, FR-022, FR-027)
- [ ] T048 [P] `ContextCollected` and `ContextPassDispatched` published through the outbox (contracts/collection-plan.md)
- [ ] T049 e2e isolation matrix: snapshot, item, pass, rejection and source-reference reads all return **404 for another tenant, never 403**, across every read path (FR-023, SC-009, quickstart 48)
- [ ] T050 [P] `check:stuck-passes` — no dispatched pass without a pending callback or a deadline (data-model invariant, 012 FR-030)

---

## Phase 5: US3 — A missing source degrades the snapshot, it does not fail it (P1)

**Independent test**: quickstart 12, 13, 14, 15, 16, 17, 18, 41, 42, 44, 45

- [ ] T051 **Test first**: disable one source → a snapshot from the remaining seven with the disabled source recorded `unavailable` and a reason; repeated for **every** source in the adapter set (FR-015, SC-005, quickstart 12)
- [ ] T052 **Test first**: disable every source → an empty snapshot is still produced with all sources recorded; collection never returns nothing at all (FR-015, SC-004, quickstart 13)
- [ ] T053 `source_outcome` writing with the six statuses and the closed reason codes, implementing T051 and T052 (FR-014)
- [ ] T054 Exactly one `collection_gap` evidence record per non-`collected` source outcome, carrying the collector key, reason code, attempt duration and item count where one exists — an absence that is recorded is an absence something can cite (FR-014, R-07, quickstart 14)
- [ ] T055 [P] `check:gap-coverage` — every non-collected source outcome has exactly one gap record and every gap record exactly one source outcome (R-07)
- [ ] T056 [P] **Test**: a consumer concludes `INSUFFICIENT_CONTEXT` citing a gap record → the conclusion persists with its evidence link instead of failing the no-conclusion-without-evidence constraint (R-07, quickstart 15, 001 FR-009, 006 FR-013)
- [ ] T057 **Test first**: a source exceeds its timeout mid-answer → what it returned is kept, marked `partial` and `truncated`, and collection does not block on it (FR-016, quickstart 16)
- [ ] T058 [P] **Test first**: revoke a collector's credentials mid-collection → `unavailable` with `auth_revoked`, distinguishable from `empty_result`, because only one of them is a configuration problem (FR-014, quickstart 17)
- [ ] T059 [P] **Test**: collect for an issue older than a source's retention → `unavailable` with `retention_exceeded` — a correct answer, not a defect (FR-014, quickstart 18)
- [ ] T060 `completeness` descriptor as a **projection** of the source outcomes, not a second store: expected, contributed, missing, partial and degraded precision, machine-readable (FR-017, R-07)
- [ ] T061 [P] `GET /context-snapshots/{snapshotId}/completeness` (FR-014, FR-017)
- [ ] T062 **Test first**: the deploy tool reports v2 live and the runtime reports v1 → both items retained, the pair named with its disagreeing field in `completeness.contradictions`, and neither dropped (R-14, quickstart 41)
- [ ] T063 [P] **Test**: collect for an issue with no resolved component → the configured default scope is used and `degradedPrecision: true` is recorded rather than the precision being assumed away (FR-017, quickstart 42)
- [ ] T064 **Test first**: exhaust the per-issue budget mid-run → the snapshot is finalised `budget_limited` from what was collected, and every uncollected source is `not_attempted` with `budget_exhausted` and its gap record (FR-024, R-15, quickstart 44)
- [ ] T065 `BudgetDegraded` and `BudgetExhausted` consumers implementing T064: the declared degradation order narrows the **next** plan and never rewrites a pass in flight, so a pass stays reproducible from its own digest (FR-024, R-15, quickstart 45, 002 FR-012)
- [ ] T066 [P] `ContextDegraded` and `ContextItemWithheld` published through the outbox, the first carrying the `gapEvidenceId` (contracts/collection-plan.md)

---

## Phase 6: US4 — The collection plan is deterministic (P2)

**Independent test**: quickstart 19, 20, 21, 22, 23, 24

- [ ] T067 **Test first**: generate the plan for the same issue 100 times → one distinct plan, one `planDigest`, and a retrievable ruleset version (FR-004, SC-007, quickstart 19)
- [ ] T068 `domain/collection-plan.ts`: the **requested** plan as a pure function of `(issue kind, component, environment, first_seen_at, collection_ruleset version)` — no capability input, no clock, no model — content-addressed as `plan_digest` (FR-004, R-04)
- [ ] T069 `collection_ruleset` as immutable versioned data mapping those facts to collectors, window and filters; a snapshot's plan recomputes from the version it recorded (FR-004, data-model)
- [ ] T070 [P] **Test**: inspect the plan-generation code path → no model call exists anywhere in it (FR-004, quickstart 20)
- [ ] T071 The **resolved** plan as `requested ∩ runner capabilities`: collectors dropped by the intersection become `not_attempted` with `capability_unavailable`, and the resolution is written to `runner_capability_resolution` — the read-path half of 012's C-02, which degrades and never refuses (R-04, 012 R-03)
- [ ] T072 **Test first**: connect a runner missing one read collector → the requested plan is unchanged and still hashes to the same digest, the collector is `not_attempted` with `capability_unavailable`, and the resolution is recorded (R-04, quickstart 21)
- [ ] T073 [P] `check:plan-determinism` — every stored `plan_digest` recomputes byte-identically from its issue facts and ruleset version (FR-004, SC-007)
- [ ] T074 **Test first**: request follow-up passes past the configured limit → `409 FOLLOW_UP_CAP_REACHED` (FR-005, quickstart 22)
- [ ] T075 `RequestFollowUpPass` implementing T074: its own `collection_pass` row with the requesting step and an enumerated reason, so "who asked for this and why" stays answerable (FR-005, quickstart 23)
- [ ] T076 **Test first**: ask for a collector key that is not in the registry → `422 UNDECLARED_COLLECTOR` over HTTP, and the in-process call does not typecheck because the field is an enum, not a validated string (FR-005, R-12, quickstart 24)
- [ ] T077 [P] `POST /issues/{issueId}/context/passes` and `GET /context/collectors` (FR-005)

---

## Phase 7: US5 — Retrieved content is data, never instructions (P2)

**Independent test**: quickstart 25, 26, 27

- [ ] T078 **Test first**: `make context-injection-diff` — run the corpus twice, with and without instruction-shaped strings in every source → byte-identical plan digest, item ordering, policy decisions and tool invocations (FR-021, SC-010, quickstart 25)
- [ ] T079 [P] **Test**: read the item carrying injected text → present as untrusted data with its source attribution intact; the attempt is neither sanitised nor erased, because a customer wants to see it (FR-021, R-11, quickstart 27)
- [ ] T080 [P] The read surface renders untrusted excerpts marked, and the prompt assembler that wraps them is the only other consumer of the branded type (FR-021, R-11)

---

## Phase 8: US6 — Ranked and deduplicated, with the reason visible (P3)

**Independent test**: quickstart 28, 29, 30, 31, 32

- [ ] T081 **Test first**: collect 12 000 lines sharing a signature → one item with the occurrence count preserved and correct first and last observed times (FR-018, quickstart 28)
- [ ] T082 `domain/dedup.ts` keyed on `(item_class, normalised_signature, component, environment)` using **001's** `normalisation_ruleset` at the version the snapshot recorded (FR-018, R-10)
- [ ] T083 [P] **Test**: compare the context dedup signature with the issue fingerprint → the same ruleset version, and no second normaliser exists in this feature (R-10, quickstart 29)
- [ ] T084 `ranking_ruleset` as immutable integer weights, and `domain/ranking/` computing the named terms — temporal proximity to first-seen, source trust rank, occurrence-count band, component match strength, deploy and change-window overlap, stack-frame path match — from **structural metadata only, never item text** (FR-019, FR-021, R-09)
- [ ] T085 **Test first**: rank the same snapshot twice, including a deliberate score tie → byte-identical ordering, with the tie resolved by the declared total order `(score desc, observed_at asc, evidence_id asc)` (SC-007, quickstart 31)
- [ ] T086 Integer sum of term contributions and the explicit total order implementing T085, with the composite index **being** the order so stability is structural rather than a sort option (FR-019, R-09, data-model)
- [ ] T087 [P] **Test**: inspect any ranked item → its score plus the named terms and their contributions, so an engineer has a weight to disagree with rather than a number (FR-019, quickstart 30)
- [ ] T088 [P] `check:ordering-stability` — item order recomputes identically from score and tiebreak, never from database return order (FR-019, SC-007)
- [ ] T089 **Test first**: exceed the configured context budget → items below the cut are **retained** with `inclusionState = excluded` and the cut score recorded; nothing is dropped silently (FR-020, quickstart 32)
- [ ] T090 Inclusion cut implementing T089 (FR-020)

---

## Phase 9: Polish and cross-cutting

- [ ] T091 [P] `check:boundary-conformance` — every stored item validates against the contract version it arrived under (SC-002)
- [ ] T092 Conformance test against [012 contracts/runner-protocol.md](../012-engineering-foundation/contracts/runner-protocol.md), the **single authority** for the closed crossing list (012 FR-022 no longer restates it). Assert every shape this feature emits is a member and that **nothing is added to the list locally** — an item class with no shape of its own is a cross-spec item for 012, never a local extension (FR-006, R-03)
- [ ] T093 [P] Performance check against the plan budget: 50 000 raw items deduplicated and ranked under 5 s, and a snapshot visible within 120 s of `IssueDetected`; record the numbers
- [ ] T094 [P] Coverage floor and `test-e2e` against disposable Postgres for `packages/domain/context/**` and the runner collection module (012 FR-012, 012 R-12)
- [ ] T095 [P] Regenerate `contracts/openapi.json` and check for drift with `contracts-check` (012 FR-010)
- [ ] T096 Run the whole of [quickstart.md](quickstart.md) — all 48 scenarios, including the fourteen that must fail, withhold or quarantine

---

## Dependencies

```text
012 phases 1–2 (incl. 012 T040) ──▶ Phase 1 (T001–T005) ──▶ Phase 2 (T006–T015)
                                                              ├─▶ Phase 3 · US1 (T016–T032)
                                                              ├─▶ Phase 4 · US2 (T033–T050)
                                                              ├─▶ Phase 5 · US3 (T051–T066) ← needs T053 before T054
                                                              ├─▶ Phase 6 · US4 (T067–T077)
                                                              ├─▶ Phase 7 · US5 (T078–T080)
                                                              └─▶ Phase 8 · US6 (T081–T090)
Phase 9 (T091–T096) last
```

**Explicit dependencies beyond phase order**

- T006 depends on 012's closed boundary schema set (012 T040), including `pull_request_ref`,
  `config_key_ref` and `knowledge_ref` (C-20). This feature conforms to that set and adds nothing to
  it; the only residual gap is stack-frame symbols and line numbers, which 012 must resolve on
  `file_path` or as a `stack_frame` shape (R-03). Nothing rides as `tool_output_summary` to work
  around a missing shape.
- T035, T043 and T044 need the workflow machine, its callback registry and its deadline tick
  (012 T013, T014); T071 needs 012's runner registration and capability resolution.
- T036, T054 and T037 need 001's evidence repository and producer attribution (001 T005, T006). The
  gap record is an evidence record, so US3's central guarantee cannot land before 001 phase 2 does.
- T082 needs 001's `normalisation_ruleset` as versioned data — deliberately, because a second
  normaliser here would make the context occurrence count disagree with the issue's.
- T065 consumes 002's budget events; write the consumer against the event contract and enable it when
  002's budget phase lands.
- T010 asserts a compile failure against 002's `DecisionInput`, so it needs that record to exist
  (002's foundational phase). Until then the same assertion holds against the ranking term signature.
- T056 needs 006's `INSUFFICIENT_CONTEXT` outcome to exist before the test can be enabled; write it
  with US3 and enable it in `ci` when 006 lands — the gap record is the half this feature owns.
- T026 is `source_file` as a collector, so it depends on the follow-up pass mechanism (T075) being in
  place; land the registry entry in US1 and the reachable path in US4.
- Phase 3 before Phase 4 in practice, even though both depend only on Phase 2: collection that
  crosses the boundary before redaction and withholding exist is collection that has already sent
  what must not be sent, and no later task un-sends it.

## Parallel groups

- Setup: T002–T005 together.
- Foundational: T013, T014, T015 after T011; T009 and T011 are independent of each other.
- US1: T023–T028 together after T018 — separate collectors, separate tests; T030–T032 after T029.
- US2: T045–T048, T050 after T040.
- US3: T055, T058, T059, T061, T063, T066 alongside T060.
- US4: T070, T073, T077 after T069.
- US6: T083, T087, T088 after T086.
- Polish: T091, T093, T094, T095.

## Strategy

1. **Phase 2 before every story, and T006 · T008 · T009 first inside it.** One schema validated
   twice, and a branded type with no accepting parameter, are what make FR-010 and FR-021 compile-time
   facts. Two copies of the schema drift, and the drift appears as data crossing that one side
   believed was declared.
2. **US1 next and completely, before any collector runs for real.** This is the product's licence to
   operate: if a raw log body crosses once, no later task retracts it, and the deployment split has
   bought nothing. Withholding (T019, T020) lands with the redactor, not after it — best-effort
   truncation is not redaction, and a partially redacted excerpt is still customer data.
3. **US2 after US1.** Parallel collection, the persisted wait and the plan-digest idempotency are the
   mechanics that make a snapshot arrive while the incident is still running. The idempotency key is
   the digest the determinism work needs anyway, which is why FR-026 gets no mechanism of its own.
4. **US3 with US2, not after it.** A collector pool that fails closed produces nothing exactly when
   observability is least healthy, and the `collection_gap` record (T054) is what makes a degraded
   snapshot a citable fact rather than a silence — without it, 006's honest unknown is a conclusion
   with nothing behind it and cannot be persisted at all.
5. **US4 after US2 and US3**, because the two-stage plan only means something once there is a runner
   whose capabilities can fall short of it: determinism stays a property of the requested plan, where
   it is testable, and degradation becomes explicit where it actually happens.
6. **US5 is small and late but not optional.** The type in T009 already carries most of it; T078 is
   the differential half, and it can only run once a plan, a ranking and a policy decision exist to
   compare — which is why it sits after US4 rather than beside T009.
7. **US6 last.** Ranking determines what a diagnosis ever sees, so it must be explainable and
   byte-stable before the benchmark runs — but a correct, honest, unranked snapshot is already useful,
   and an unexplained ranking on an incomplete snapshot would be an invisible filter over a hole.
8. Phase 9 before the pilot. The conformance, determinism, ordering and no-payload-at-rest checks run
   continuously: three of them guard properties a customer's security review will ask about.
