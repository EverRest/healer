# Tasks: Historical replay and the benchmark

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/openapi.yaml](contracts/openapi.yaml),
[contracts/scoring.md](contracts/scoring.md), [quickstart.md](quickstart.md)

**Prerequisites**: [012](../012-engineering-foundation/tasks.md) phases 1–2 and 9 — workflow machine,
outbox, tenancy context, gate harness, `agent_run` cost accounting, and the content-addressed prompt
registry a run pins against; [001](../001-issue-and-evidence/tasks.md) — issues, evidence, producer
attribution, audit entries; [002](../002-policy-and-autonomy/spec.md) — dry-run policy evaluation and
budgets; read-only access to the outputs of [006](../006-diagnosis/spec.md),
[007](../007-reproduction-and-sandbox/spec.md) and [008](../008-change-and-verification/spec.md),
which this feature consumes and never re-derives.

**Tests**: TDD is constitutional. The negative guarantees here are the feature: a mutation that
cannot be reached, a scorer that was never handed the patch, a threshold that cannot be inserted.
Each gets a test seen to fail first, and the capability and constraint tests assert on the *shape* of
the run and the schema, not on a call that happened to be refused.

**Organization**: one phase per user story. US1–US5 are P1; US6–US8 are P2 but US6 precedes US4 for
the reason in Strategy 5.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [ ] T001 Packages `packages/domain/evaluation` and `packages/shared/capabilities` with the layer layout in [plan.md](plan.md) and their entry surfaces declared (012 FR-001)
- [ ] T002 [P] Prisma models for schema `eval` per [data-model.md](data-model.md); first migration, every table carrying `tenant_id` with its `(tenant_id, …)` index (FR-024)
- [ ] T003 [P] Evaluation-designated routing adapter registered only inside `packages/domain/evaluation/**`, with the boundary lint pattern that forbids the production path importing it (FR-009, R-14, 012 FR-003)

---

## Phase 2: Foundational (blocks US1–US8)

- [ ] T004 **Test first**: import an entry carrying a free-form log-body field → rejected `UNREDACTED_FIELD` with nothing stored; redaction is the customer's, done in their plane (FR-025, R-10, quickstart 42)
- [ ] T005 `golden_issue` import accepting only the closed evidence shapes of the boundary contract plus a repository reference and commit SHA — there is no free-form field to scan (012 T040, FR-010, FR-025, R-10)
- [ ] T006 **Test**: inspect everything the control plane holds for an entry → references, digests and closed shapes; no customer source at rest (R-10, C-04, quickstart 43)
- [ ] T007 `POST /eval/entries` and `GET /eval/entries` with `origin` mandatory and never defaulted, and `fix_ref` accepted as provenance only ([contracts/openapi.yaml](contracts/openapi.yaml), FR-010, FR-011)
- [ ] T008 [P] `run_configuration` as an immutable pinned set with a digest over every field, including routing, temperature and seed (FR-006, R-03)
- [ ] T009 [P] `simulation_run` over 012's workflow machine with per-entry checkpoints and `resume_cursor`; a dataset run is persisted state, never a job that waits (012 T013, FR-023, R-12, 012 FR-025)
- [ ] T010 [P] `TenantContext` on every repository method; a cross-tenant read, aggregate or comparison is unrepresentable in the query rather than filtered afterwards (012 T010, FR-024)
- [ ] T011 [P] Evidence and audit wiring: every conclusion in a run report carries links emitted by its producing step, and every run is written to the audit trail with its configuration, inputs, decisions and outcome (001 T005, 001 T006, FR-027, 001 FR-008)
- [ ] T012 Cost read from 012's `agent_run` rows by correlation identifier, so a benchmark cost and a live cost are the same accounting; **no second cost counter exists** (FR-016, 012 FR-036, VIII, quickstart 45)

**Checkpoint**: entries can be imported and a run can be recorded; nothing can be executed or scored
yet.

---

## Phase 3: US2 — A simulation cannot touch production (Priority: P1) 🎯 MVP

**Goal**: three independent structural facts — capability passing, credential minting, directive
channel — so a mutating function cannot be reached from a run rather than merely not being called.

**Independent test**: quickstart 6, 7, 8, 9, 10

- [ ] T013 **Test first**: the attempt matrix — from inside a run, attempt every mutating operation in the product (repository write and pull-request creation, remediation dispatch, support answer publication, knowledge draft publication) and assert each is unreachable with the refusal recorded (FR-004, SC-001, [ADR 0008](../../docs/adr/0008-capability-passing.md), quickstart 6)
- [ ] T014 **Test first**: assert a simulation run's bundle cannot obtain **any of the four** ADR 0008 capabilities — `RepositoryWriteCapability`, `RemediationDispatchCapability`, `AnswerPublishCapability`, `DraftPublishCapability` — as **four separate per-capability assertions over the bundle's contents**, not one assertion per call site and not the outcome of a call, because "the call was refused" is a weaker claim than "the capability is absent". `DraftPublishCapability` is in scope for the same reason as the others: a knowledge draft is where an `ExpectedBehavior` adoption starts (D-20, 005), so a run able to publish one would be manufacturing the anchors it is later scored against (FR-004, R-01, US-2 scenario 2, [ADR 0008](../../docs/adr/0008-capability-passing.md))
- [ ] T015 `packages/shared/capabilities`: the four capability types of ADR 0008, taken as an argument by every mutating call site and resolvable from no container, module import, ambient configuration or global ([ADR 0008](../../docs/adr/0008-capability-passing.md), FR-004)
- [ ] T016 Simulation capability bundle construction containing none of them, recorded verbatim in `simulation_run.capability_set` (FR-004, R-01)
- [ ] T017 **Test first**: search every mutating call site for a branch on run type or a `dryRun` parameter → none exists; the gate is the capability argument in the signature (FR-004, R-01, quickstart 7, 9)
- [ ] T018 Credential minting over a **closed principal-kind enum**: a `simulation` principal has no representable grant for a production credential, a repository push token or a remediation credential, so even a smuggled capability resolves to nothing (FR-005, R-01, quickstart 8)
- [ ] T019 **Test**: no configuration surface and no request body carries a capability field, and an attempt to grant a simulation run a mutating capability is refused by a product-level limit (FR-005, SC-002, 002 FR-008, quickstart 8)
- [ ] T020 A run's runner session is opened as `evidence_and_sandbox_only`: the directive union it may emit contains `collection_plan`, `reproduction_directive` and **`change_plan` scoped to a sandbox workspace**, and does **not** contain `remediation_directive` — a shape it cannot construct it cannot send. `change_plan` is in the union because `false_fix_rate` is defined over gate results and a post-change reproduction, neither of which exists if the candidate patch is never applied; the workspace holds no production credentials, has default-deny egress and is destroyed afterwards, and repository write stays excluded because it takes a capability the bundle does not hold (C-10, FR-004a, R-01, 012 T040, 010 FR-009)
- [ ] T021 [P] Sandbox hygiene for every run: no production credentials, default-deny egress, workspace destroyed afterwards (FR-026, 007 FR-011, quickstart 10)
- [ ] T022 [P] Continuous check `check:run-capabilities` — no run context holds a mutating capability (SC-001)

**Checkpoint**: the simulator is safe to run before anything has been trusted, and its safety is not
a setting.

---

## Phase 4: US1 — Point us at your last twenty incidents (Priority: P1)

**Goal**: one replay mechanism, a complete report per input, and a refusal reported as output.

**Independent test**: quickstart 1, 2, 3, 4, 5, 11

- [ ] T023 **Test first**: replay a historical entry → the report carries the diagnosis, the reproduction outcome, the proposed change plan, every policy decision with the rules that produced it, the risk classification, the cost and the step at which it would have stopped (FR-002, quickstart 2)
- [ ] T024 One replay executor over an ordered set of run inputs producing a `run_report` per input; a single-issue simulation and a dataset benchmark differ **only** in input selection and reporting (FR-001, R-02)
- [ ] T025 `run_report` persistence and `GET /eval/runs/{runId}/reports` ([contracts/openapi.yaml](contracts/openapi.yaml), FR-002)
- [ ] T026 Policy inside a run is 002's dry-run evaluation with the tenant's actual configuration and the rules that produced each decision; **no second rule engine exists in this package** (FR-003, 002 FR-019, quickstart 4)
- [ ] T027 `stop_point` and the missing grant as first-class output — "would have required approval, grant missing for component X" is a result, never an error (FR-003, quickstart 3)
- [ ] T028 [P] **Test**: every claim in a report resolves to evidence records emitted by the producing step (FR-027, 001 FR-008, 001 FR-009, quickstart 5)
- [ ] T029 [P] Read-only replay of a currently open issue: reads live evidence, produces a plan, and never joins the live workflow (FR-001, edge case, quickstart 11)
- [ ] T030 The zero-integration path: the prospect runs the runner image on a machine that can see their repository and their export, outbound only, with no inbound rule and no credential granted by us; only closed evidence shapes and the structured report cross to the control plane (SC-008, R-11, C-01, quickstart 1)
- [ ] T031 [P] `POST /eval/runs`, `GET /eval/runs` and `GET /eval/runs/{runId}` ([contracts/openapi.yaml](contracts/openapi.yaml), FR-001)

**Checkpoint**: twenty incidents can be replayed for a tenant that has granted nothing, and the demo
is the same code path the benchmark will measure.

---

## Phase 5: US3 — Scored on behaviour, never on resemblance to the human patch (Priority: P1)

**Goal**: five tri-state criteria, each with an anchor that pre-dates the run, computed by a function
that was never handed the engineer's diff.

**Independent test**: quickstart 12, 13, 14, 15, 16, 17, 44

- [ ] T032 **Test first**: inspect the scoring input **type** → no diff, no `fixRef`, no field that could hold either; the check is on the type, not on the scoring body (FR-014, SC-005, R-06, quickstart 14)
- [ ] T033 `ScoringInput` per [contracts/scoring.md](contracts/scoring.md) — `proposal`, `groundTruth`, `entry` — where `groundTruth` holds the historical outcome, the pre-existing suite reference, the reproduction result and the recurrence observation, and `fix_ref` stays on the dataset entry for a human reading the case (FR-014, R-06)
- [ ] T034 **Test first**: score a behaviourally correct fix structurally unlike the human patch → `success`; score a lookalike that leaves the original failure reproducing → `false_fix` (FR-013, FR-014, quickstart 12, 13)
- [ ] T035 The five criteria as tri-state predicates — `regression_test_passes`, `original_failure_not_reproducible`, `pre_existing_suite_passes`, `no_unintended_change`, `incident_did_not_recur` — each recording its `anchor_kind` and `anchor_ref` (FR-013, FR-015, [contracts/scoring.md](contracts/scoring.md))
- [ ] T036 **Test first**: score a replayed historical entry → `incident_did_not_recur` resolves `not_applicable` with its reason, because nothing was merged so nothing could recur; it is never a pass (R-07, quickstart 16)
- [ ] T037 Verdict aggregation over applicable criteria only, naming the inapplicable ones; fewer than two applicable is `unscored`, excluded from every denominator and never counted as a failure (FR-012, R-07, quickstart 17)
- [ ] T038 [P] **Test**: every criterion's anchor is the recorded historical outcome, the pre-existing suite, raw evidence or an adopted expectation — never an artifact the same run produced (FR-015, II, quickstart 15)
- [ ] T039 [P] **Test**: seed reports with high and low model-reported confidence → identical scores; confidence is recorded alongside the score for calibration and read by no predicate (FR-028, 002 FR-003, quickstart 44)
- [ ] T040 `ScoreEntry` committing one entry's report and score as it completes, so a run can suspend and resume without repeating work (R-12, FR-023)
- [ ] T041 [P] Continuous check `check:scoring-input` — the scoring input type carries no patch and no diff (SC-005)

**Checkpoint**: a fix better than the engineer's original scores as a success, and a similarity metric
has no data to be written against.

---

## Phase 6: US5 — The same run twice produces the same result (Priority: P1)

**Goal**: reproducibility as something a run earns, and routing recorded rather than assumed.

**Independent test**: quickstart 22, 23, 24, 25, 26

- [ ] T042 **Test first**: execute the same pinned configuration twice → identical behavioural scores promote the run to `reproducible`; an induced divergence marks it `non_reproducible` and names the diverging component (FR-007, SC-003, R-03, quickstart 22)
- [ ] T043 Reproducibility lifecycle: a run starts `unverified` and is promoted only by a repeat of the identical configuration digest producing identical behavioural scores — not identical text (R-03, FR-007)
- [ ] T044 **Test first**: remove the pinned model version and re-run → fails `PINNED_VERSION_UNAVAILABLE` with no substitution of another version (FR-008, quickstart 23)
- [ ] T045 Pinned-version resolution at run start for the model version and every `prompt_version_id`; a configuration that cannot resolve them all does not start (FR-008, SC-004, 012 FR-038, 012 FR-039)
- [ ] T046 **Test first**: configure an agent to resolve a prompt by path or by key alone → the run refuses to start `PROMPT_RESOLUTION_BY_PATH` (R-13, 012 FR-038, quickstart 24)
- [ ] T047 Temperature zero and a fixed seed where the provider supports one, both part of the configuration digest (R-03, FR-006)
- [ ] T048 **Test first**: run for a Healer-provided tenant and for a BYO tenant → the routing is recorded in run metadata, and the BYO tenant's run makes **no call to a Healer-managed provider** (FR-009, R-14, 012 FR-046, 012 SC-016, quickstart 25)
- [ ] T049 Evaluation routing resolved within the tenant's declared provider scope (D-10 as amended by R-14): `evaluation_shared` for a Healer-provided tenant, `tenant_provider` for a BYO tenant, recorded and included in the configuration digest so runs are comparable only within the same routing (FR-009, R-14)
- [ ] T050 [P] **Test**: import the evaluation routing adapter from outside the evaluation package → `lint` fails on the boundary pattern (FR-009, 012 FR-003, quickstart 26)

**Checkpoint**: a number from this harness can be defended, and no benchmark run leaks a BYO tenant's
context to a Healer-managed provider.

---

## Phase 7: US6 — Real incidents preferred, synthetic ones labelled (Priority: P2)

**Goal**: cohorts that exist, a combined figure that has nowhere to live, and an unrunnable entry
that is reported rather than scored.

**Independent test**: quickstart 27, 28, 39, 40, 41

- [ ] T051 **Test first**: request a metric without a cohort → rejected; and assert the cohort enum has no `combined` member and no column exists that could hold an overall figure (C-05, R-05, quickstart 28)
- [ ] T052 `run_metric` keyed by `(run, metric, cohort)` with `cohort` in `real | synthetic` only (R-05, FR-011, C-05)
- [ ] T053 [P] A report over a mixed dataset shows two labelled numbers per metric and states the synthetic share; no headline combines them (FR-011, SC-007, quickstart 27)
- [ ] T054 `dataset_version` publication computing `real_count` and `synthetic_count` from the member entries and freezing them — neither is settable by a caller (R-04, FR-019)
- [ ] T055 **Test first**: change the dataset → a new immutable version is published and prior runs still reference the version they used (FR-019, quickstart 39)
- [ ] T056 [P] An entry whose repo state or required context is unrecoverable is reported unrunnable and excluded from denominators, never scored as a failure (FR-012, quickstart 40)
- [ ] T057 [P] An entry whose dependencies are no longer installable reports an environment failure, distinct from a Healer miss and not scored as one (edge case, quickstart 41)
- [ ] T058 [P] `POST /eval/dataset-versions` and `GET /eval/dataset-versions` ([contracts/openapi.yaml](contracts/openapi.yaml), FR-019)
- [ ] T059 [P] Continuous check `check:no-combined-cohort` — no metric row exists outside `{real, synthetic}` (C-05)
- [ ] T092 **Test first**: attempt to update `golden_issue.split` through the repository and through raw SQL → both refused; a reclassification is a **new entry**, so an incident cannot enter the sealed set after it was tuned on (FR-011a, R-19, quickstart 49)
- [ ] T093 `golden_issue.split` as `dev | benchmark`, **mandatory with no default**, on the entry rather than on `dataset_entry` membership — membership-level split would let one incident be `dev` in version 3 and `benchmark` in version 4; `dataset_version.composition` carries the split breakdown computed at publication (FR-011a, R-19)
- [ ] T094 `run_configuration.split_filter` as part of the configuration **digest** (intent) and `simulation_run.split_scope` computed from the entries the run actually **scored** (outcome), never accepted from a caller — the same separation as dataset counts versus scored counts (FR-021b, R-19, R-04)

**Checkpoint**: synthetic material can no longer inflate a number without saying so, and tuning material
cannot reach a threshold.

---

## Phase 8: US4 — False-fix rate and 30-day revert rate (Priority: P1)

**Goal**: the two numbers that decide whether anyone trusts the product, with their denominators, and
a revert rate that says "not yet measurable" instead of zero.

**Independent test**: quickstart 18, 19, 20, 21, 47

- [ ] T060 **Test first**: run a benchmark seeded with known false fixes → the reported false-fix rate matches the seeded count exactly (SC-006, quickstart 18)
- [ ] T061 False fix as a predicate over recorded facts: every gate the run applied passed — RED, GREEN, the pre-existing suite and a verifier `APPROVE` — and at least one applicable behavioural criterion failed (FR-017, R-08, 008 FR-009, 008 FR-017)
- [ ] T062 [P] Every false fix retains the gates it passed, the evidence it used, the model and the prompt version, individually inspectable (FR-017, quickstart 19)
- [ ] T063 `run_metric` computation for every metric in [contracts/scoring.md](contracts/scoring.md), each with its numerator, its denominator and its exclusions stated (FR-016, SC-007)
- [ ] T064 **Test first**: request `revert_rate_30d` with no L2 tenant history → `insufficient_observation` with the reason stated; never `0` and never omitted (R-09, quickstart 20)
- [ ] T065 `availability` as `available | insufficient_observation | not_applicable` with a nullable value, implementing T064 across every metric (R-09, FR-016)
- [ ] T066 **Test first**: revert a merged Healer-produced change on day 12 → the revert is attributed back to the run that produced it and counted once the window closes (FR-018, quickstart 21)
- [ ] T067 `revert_observation` written by a scheduled reconciliation over merged changes whose thirty-day window has closed; **no job waits for thirty days**, and a row with `observed_at` null contributes to neither numerator nor denominator (FR-018, R-09, 012 FR-025, quickstart 47)
- [ ] T068 [P] `GET /eval/runs/{runId}/metrics` with a required cohort, and `GET /eval/runs/{runId}/scores` ([contracts/openapi.yaml](contracts/openapi.yaml), FR-016)

**Checkpoint**: the two metrics almost nobody measures are measured, and neither can be read as
flattering by accident.

---

## Phase 9: US7 — Compare models and prompt versions on identical issues (Priority: P2)

**Goal**: per-issue deltas, so an aggregate improvement cannot hide a new false fix.

**Independent test**: quickstart 37, 38

- [ ] T069 **Test first**: two runs over one dataset version differing only in prompt version → per-issue outcome changes in both directions, with every `success → false_fix` highlighted independently of the aggregate direction (FR-020, quickstart 37)
- [ ] T070 `CompareRuns` as a query over two runs sharing `dataset_version_id` and `scoring_version`; storing the comparison would be a cache of a join (FR-020, VIII)
- [ ] T071 [P] Comparison guards: a differing dataset version, a differing scoring version, or two tenants are each refused with their own code (FR-020, FR-024, quickstart 38)
- [ ] T072 [P] `GET /eval/comparisons` ([contracts/openapi.yaml](contracts/openapi.yaml), FR-020)

**Checkpoint**: a prompt or model change can be justified, and a regression inside an improvement is
visible.

---

## Phase 10: US8 — Thresholds traceable to the data that justified them (Priority: P2)

**Goal**: C-05 as four check constraints, and the stage-0 feed that turns a run into the numbers the
constitution deliberately leaves unset.

**Independent test**: quickstart 29, 30, 31, 32, 33, 34, 35, 36, 48

- [ ] T073 **Test first**: derive a threshold from a run that scored exactly one synthetic entry → refused by a check constraint; assert the refusal also holds for a direct SQL insert, because a handler validation is bypassed by the first script (SC-009, R-04, quickstart 29)
- [ ] T074 The four `threshold_derivation` check constraints, landing in the **same** migration as the table and written over the row's **own** columns: `run_synthetic_scored_count = 0`, `run_completion_state = 'complete'`, `run_reproducibility = 'reproducible'`, `real_denominator >= 20`. The three run facts are denormalised onto the derivation at insert and held equal to the run's by a **composite foreign key** onto a unique key `simulation_run (id, synthetic_scored_count, completion_state, reproducibility)`. A `CHECK` cannot span tables, so constraints referencing `simulation_run`'s columns would simply not exist — C-05's mechanism would be a comment (R-04, C-05, FR-021, FR-023)
- [ ] T075 `min_real_yield` as a **product constant of 20**, established the way 002's `ACTION_CEILING` is: a constant in `domain/threshold.ts`, the literal `20` written into the migration's `CHECK (real_denominator >= 20)`, and a **test** asserting the two agree and that no configuration path, request body or environment variable can lower either. A `CHECK` cannot call a function that reads configuration, which is the property wanted rather than a limitation worked around (FR-021a, R-15, SC-011)
- [ ] T076 `simulation_run.synthetic_scored_count`, `real_scored_count` and `unrunnable_count` counting what the run actually **scored**, which is not what the dataset held (R-04, FR-012)
- [ ] T077 **Test first**: exhaust the run budget mid-dataset, resume, then attempt a derivation → the run suspends `partial` with the consumed budget recorded, resumes from the first unscored entry, and the derivation is refused (FR-023, R-12, 002 FR-011, quickstart 30)
- [ ] T078 [P] **Test**: mark a run `non_reproducible`, then attempt a derivation → refused (R-03, FR-007, quickstart 31)
- [ ] T079 **Test first**: a 25-entry dataset with 8 unrunnable entries → the scored real denominator is 17 and the derivation is refused below the minimum yield; the subject of the minimum is the denominator, not the dataset size (R-04, SC-011, quickstart 32, 48)
- [ ] T080 `real_denominator` recorded per derivation from the scored real cohort of the metric it cites, never from the dataset size (R-04, SC-011)
- [ ] T081 [P] **Test**: real yield too small → no derivation row exists, nothing records "no threshold", and the L2 ceiling simply holds (C-05, constitution Governance, quickstart 33)
- [ ] T082 `POST /eval/thresholds` and `GET /eval/thresholds`, each threshold in effect resolving to its run, dataset version, metric and real denominator (FR-021, SC-009, quickstart 34)
- [ ] T083 [P] A threshold change is audited with who changed it, the prior value and the run supporting the new one; rows are superseded via `superseded_by_id` and never edited (FR-021, 002 FR-020, quickstart 35)
- [ ] T084 A completed run whose metrics contradict a threshold in effect raises a conflict against that derivation rather than letting the threshold stand silently (FR-022, quickstart 36)
- [ ] T085 The stage-0 S0-3 feed: `false_fix_rate`, `per_incident_cost_ceiling`, `tenant_daily_budget` and `escalation_attempt_cap` each become a `threshold_derivation` row naming the run, the dataset version, the metric and the real denominator — or they remain underived and the ceiling holds (FR-021, quickstart "Feeding stage 0")
- [ ] T086 [P] Continuous check `check:threshold-eligibility` — every derivation cites a complete, reproducible, real-only run (SC-009)
- [ ] T095 **Test first**: derive a threshold from a run that scored exactly one `dev` entry → refused by a check constraint, and refused for a direct SQL insert too; then re-mark a `benchmark` run's scope and assert the update is refused while a derivation cites it (FR-021b, SC-012, quickstart 50)
- [ ] T096 The **fifth** `threshold_derivation` check constraint, `run_split_scope = 'benchmark'`, landing in the same migration as the other four, with `split_scope` added to the composite foreign key and to the unique key on `simulation_run (id, synthetic_scored_count, completion_state, reproducibility, split_scope)` — the copy stays provably equal to the run's own value rather than being trusted (FR-021b, R-19, R-04)
- [ ] T097 Derivation artifact export: publishing a derivation writes a self-contained file under `docs/derivations/` naming the threshold, value, run, dataset version, metric, scored real denominator and the four run facts, and records its digest in `artifact_digest` — the row stays the authority, the artifact is what a CI check with no database can resolve (FR-021c, R-20, 012 `gate-ceiling`)
- [ ] T098 [P] Continuous check `check:derivation-artifacts` — reconciles committed artifacts against rows **in both directions**: an artifact with no row, a row in effect with no artifact, or a digest that disagrees is a failure. The second mechanism, because a file can be hand-written and a row cannot (SC-013, R-20)

**Checkpoint**: no autonomy-governing number can rest on synthetic material, tuning material, a partial
run or a run nobody can repeat — and a ceiling raise has something a build can resolve.

---

## Phase 11: Polish and cross-cutting

- [ ] T087 [P] e2e isolation matrix: another tenant's entries, runs, reports, scores, metrics and thresholds all return 404, never 403 (FR-024, SC-010, quickstart 46)
- [ ] T088 [P] `make eval` as a release-gate target deliberately outside `make ci`, run on release candidates and on any change to prompts, agents or policy (quickstart header, 012 `contracts/make-targets.md`)
- [ ] T089 [P] Regenerate `contracts/openapi.json` and check for drift against the committed artifact (012 FR-010)
- [ ] T090 [P] Assert the stage-0 exit condition before any threshold is derived: the run's **scored real denominator** for the cited metric reaches 20 — scored real results, never dataset rows, which is what SC-011 now says (SC-011, R-04, R-15)
- [ ] T091 Run the whole of [quickstart.md](quickstart.md) — all 51 scenarios including the ones that must be impossible, plus the five invariant checks

---

## Dependencies

```text
012 phases 1–2 + 9 · 001 · 002 · read-only 006 / 007 / 008
   └─▶ Phase 1 (T001–T003)
          └─▶ Phase 2 (T004–T012)
                 └─▶ Phase 3 · US2 (T013–T022)   blocks every run
                        └─▶ Phase 4 · US1 (T023–T031)
                               └─▶ Phase 5 · US3 (T032–T041)
                                      ├─▶ Phase 6 · US5 (T042–T050)
                                      └─▶ Phase 7 · US6 (T051–T059)
                                             └─▶ Phase 8 · US4 (T060–T068)
                                                    ├─▶ Phase 9 · US7 (T069–T072)
                                                    └─▶ Phase 10 · US8 (T073–T086)
                                                          ← also needs Phase 6
Phase 11 (T087–T091) last
```

**Explicit dependencies beyond phase order**

- T015 must land before 008, 009 and 010 write their mutating call sites. ADR 0008's own consequence
  section says retrofitting a missed operation is invasive, and until the capability argument exists
  those call sites have nothing to take.
- T020 depends on 012's closed boundary schema set and its directive union (012 T040): a simulation's
  safety here is that `remediation_directive` is not a member of the union it may construct.
- T009 depends on 012's workflow machine (012 T013); T067's reconciliation is a scheduled tick over
  closed windows, not a wait.
- T045 and T046 depend on 012 phase 9 — prompts resolve by version identifier only, which is what
  makes R-13's hole closeable at run start rather than detectable afterwards.
- T035's criteria consume 007's reproduction result and 008's impact analysis and verifier verdict
  read-only. Until those land, each affected criterion resolves `not_applicable` **with its reason**,
  which is the honest state and not a stub — this is exactly the behaviour T036 asserts.
- T012 reads 012's `agent_run`; there is no cost counter to build here, only a sum to take.
- T026 depends on 002's dry-run evaluation; a second rule engine in this package would be the thing
  the benchmark is meant to catch.
- T075 (`min_real_yield`) ships in T074's migration, not after it: a derivation written while the bound
  is a symbol with no SQL definition is a number nobody can defend, which is the same window R-04 exists
  to close.
- T073–T080 need Phase 6 as well as Phase 8: two of the four constraints are about completion and
  reproducibility, so the threshold phase cannot close before US5 does.
- T074's constraints ship in the migration that creates the table. Any window in which the rule is
  application-level validation is the window R-04 exists to eliminate.
- T084 needs to know which derivation is in effect for a threshold key; it reads the latest
  non-superseded row, and the consumer of that value is 002's policy configuration.

## Parallel groups

- Setup: T002, T003 together.
- Foundational: T008–T011 after T005, then T012.
- US2: T021, T022 after T015–T020.
- US1: T028, T029, T031 after T024–T027.
- US3: T038, T039, T041 after T035.
- US6: T053, T056, T057, T058, T059.
- US4: T062, T068.
- US7: T071, T072 after T070.
- US8: T078, T081, T083, T086.
- Polish: T087–T090.

## Strategy

1. **Phase 3 (US2) first among the stories, and before 008, 009 and 010 write a mutation.** The
   guarantee is the product: everything else here is reporting. Building the replay first and adding
   the capability bundle later means the simulator was unsafe for the whole interval, and the interval
   is when it gets demonstrated to prospects.
2. **Phase 2's import path before everything**, because every story needs entries and because T004's
   rejection rule is free to enforce while the dataset is empty and expensive once it is not.
3. **US1 next: one executor, two readings (R-02).** A demo path built first and a benchmark path built
   later are two code paths, and the demo drifts toward flattering — which is the failure this
   feature exists to prevent in the product it measures.
4. **US3 before US5, US4 and US8.** Reproducibility is defined over behavioural scores; metrics are
   defined over verdicts; thresholds are defined over metrics. There is exactly one possible order
   here, and T032 belongs at the front of it because the scoring input type is cheapest to get right
   before anything reads it.
5. **US6 before US4, despite the lower priority.** A `run_metric` row is keyed by cohort, so the
   cohort rule must exist before the first metric is computed. Adding the key afterwards means
   migrating rows that already carry a combined figure, and that figure is the artifact C-05 forbids.
6. **US5 alongside US3 and US6** if there is capacity — pinning, prompt resolution and routing are
   independent of scoring content. T048 in particular runs before any BYO tenant is benchmarked,
   because the naive reading of D-10 breaches 012 FR-046 silently and would be found by an audit
   rather than by a test.
7. **US8 last of the stories, with its constraints in the table's own migration.** A threshold is the
   output of everything above it, and a derivation written during a validated-in-code period is a
   number nobody can defend afterwards.
8. **Phase 11 before stage 0 closes.** S0-3 rests on a full quickstart run, including the scenarios
   that must be refused — a threshold derived from a harness whose negative cases were never executed
   is the same opinion-with-a-number the constitution left unset on purpose.
