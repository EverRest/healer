# Quickstart: reproduction and sandbox

```bash
make bootstrap
make test -- --testPathPattern domain/reproduction
make test -- --testPathPattern sandbox
make test-e2e -- --testPathPattern 007-
make sandbox-redteam            # the hostile fixture suite; part of `make ci` (SC-003, SC-004)
make adapter-conformance        # every registered adapter, all eight fixtures
```

## Scenarios

Weighted toward the hostile ones and toward the outcomes that must never be `PASS`. A denial nobody
has watched happen is not known to work.

### The gate

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 1 | Nothing modified until something fails | seed a known defect, run the engine | a reproduction that fails on the affected commit and passes on the fixed one; only then is the change path open (US1) |
| 2 | No `FAIL`, no change | propose a change with no reproduction on record | refused; the view returns a row with `eligible = false` and `blockedBy = [no_attempt]` (FR-001, SC-001, R-16) |
| 3 | No bypass exists | search the API and the repository for a way to set change eligibility | none — it is a view (R-16) |
| 4 | `PASS` closes the path | reproduction runs cleanly | result `PASS`, diagnosis marked unconfirmed by execution, change path closed (US1 scenario 2) |
| 5 | Two views compose | make 006 eligible and 007 `PASS`, then the reverse | change refused in both directions; neither view can be written |

### The ladder

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 6 | Cheapest rung wins | seed an issue reproducible at `unit` | stops at `unit`; **no `rung_attempt` row exists for any higher rung** (SC-002) |
| 7 | One issue per rung | seed issues designed to reproduce at each of the six | each stops at its rung, none climbs past it |
| 8 | Climbing records rejections | an issue needing a data shape | `unit` and `request` recorded `not_reproduced` with their reasons, then `data` reproduces |
| 9 | Skips are not climbs | no concurrency entry point exists | `skipped` with `no_entry_point` — not `not_reproduced` (R-03) |
| 10 | The ceiling holds | directive with `maxRung = request`, issue reproducible at `data` | `data` recorded `skipped` / `above_max_rung`; result `INCONCLUSIVE`, not a silent stop (R-13 of 006) |
| 11 | The hint is not a start | directive with `suggestedRung = concurrency` | the engine still begins at `unit` (ladder contract) |
| 12 | Budget mid-climb | exhaust the per-issue budget between rungs | `INCONCLUSIVE` / `budget_exhausted`, ladder state preserved (002 FR-011) |

### Signature matching

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 13 | A match is an equality | reproduce the seeded defect | signatures equal under the **issue's** recorded ruleset version (R-02) |
| 14 | A different failure is not a reproduction | make the sandbox throw a different exception at the same entry point | `INCONCLUSIVE` / `signature_mismatch` plus a separate-defect finding — never `FAIL` (FR-005) |
| 15 | Harness frames tolerated | run the same defect under the test harness | the issue's frames are a contiguous suffix; still `FAIL` |
| 16 | Caller changed, innermost same | wrap the call site | still `FAIL` — the innermost frame is identical |
| 17 | New ruleset does not rewrite history | publish a new normalisation ruleset, re-run an old issue | matched under the version the issue recorded, not the newest |

### Intermittency

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 18 | 3 in 10 | seed a race reproducing intermittently | `FAIL`, `intermittent = true`, `observedRate = 0.3` on the reproducing rung and copied to the attempt — never a sum across rungs — and carried to 008 as the repeat count GREEN must clear (FR-007, R-18) |
| 19 | 10 in 10 is a different fact | a deterministic defect at `concurrency` | `intermittent = false`; the two are distinguishable downstream |
| 20 | 007 does not judge the rate | inspect the engine for a threshold on `observedRate` | none — 008 FR-013 owns what a flaky result may prove (R-04) |
| 21 | Repeats are per rung class | run rung `unit` and rung `load` | `unit` runs once plus a confirm; `load` runs `n` repeats |

### `INCONCLUSIVE` is an answer

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 22 | Nothing reproduces | run against a known non-reproducible incident | `INCONCLUSIVE` / `no_rung_reproduced`, routed to a human — not a failure state (US3) |
| 23 | The handoff is worth reading | read it | every rung with outcome, timing and cost, plus the rejected hypotheses from 006 (FR-006) |
| 24 | `INCONCLUSIVE` refuses a change | propose one | refused for the same reason `PASS` refuses it |
| 25 | Every reason routes | force each of the ten `inconclusiveReason` values | all ten reach a human; none is recorded as `PASS` (R-05, SC-006) |
| 26 | Commit gone | force-push away the target commit | `INCONCLUSIVE` / `commit_unavailable`; the correlated deploy evidence is preserved |
| 27 | Build broken | break the build at the target commit | `INCONCLUSIVE` / `build_failure`, distinguished from a test failure, build output as evidence (FR-017) |
| 28 | Runner too old | connect a runner below the capability floor | `INCONCLUSIVE` / `capability_refused`; the rung skip crosses as a `collection_gap` (C-02) |

### The sandbox is hostile to what it runs

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 29 | Egress denied | a test opens a socket to the internet | fails at the syscall — the run container has no default route; the failure surfaces in the parsed runner output and the run's `egressPosture` records that there was no route (US4, R-08, R-19) |
| 30 | DNS denied | a test resolves a hostname | fails; no resolver is reachable |
| 31 | Prefetch is the only network | inspect the two containers | prefetch has a per-profile, registry-only allowlist fixed at image-build time; the run container has **no egress configuration at all** to misconfigure (FR-011) |
| 32 | Red-team fixture | egress, credential probe, fork bomb, hang, shared-path write | every attempt denied or bounded; each denial appears on the run record (SC-003) |
| 33 | No credentials | inspect the run environment | no production credential, no repository write credential, no tenant secret (FR-012) |
| 34 | Scanned both ends | mount a credential deliberately | pre-run scan aborts before the checkout is readable; post-run scan runs on output (R-09, SC-004) |
| 35 | Hang killed | a test that never terminates | process tree killed at the wall clock; `TIMEOUT` → `INCONCLUSIVE`, never `PASS` (FR-016) |
| 36 | Workspace gone | inspect the filesystem after success, after failure, after a SIGKILL | destroyed on every path; the next run starts fresh (FR-014, R-07) |
| 37 | Destruction is not cleanup code | kill the container mid-run | the workspace still does not survive — it is tmpfs inside it |
| 38 | Reconciliation catches the runtime | leave a workspace behind artificially | the reconciliation job reports it within the grace period (SC-005) |
| 39 | Escape the workspace | a test writes to a mounted path and to the shared cache | denied; the cache is read-only; the denial is recorded, not tolerated |
| 40 | Two tenants | run concurrently, inspect filesystem, cache and execution records | nothing of the other tenant is reachable; the dependency cache is per tenant (FR-030, R-09) |
| 41 | No route home | model-generated code tries to reach the control plane | refused; the only path out is the structured result contract (R-15) |
| 42 | No shell | inspect the agent's tool set | exactly `runReproduction` and `runTests`, schema-validated and audited (FR-028) |
| 43 | Capacity queues | saturate a tenant's concurrent runs | further runs are `queued` with observable depth; **no worker job is blocked** (R-12) |
| 44 | Retry is a new run | fail infrastructure, retry | new execution id, `supersededBy` set, results never merged (FR-013, R-13) |
| 45 | Environment recorded | run twice with a floating dependency | both record resolved versions and digests; a divergent re-run is explainable (FR-015, R-14) |

### Reproducing a data bug without taking the data

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 46 | Shape first | a defect triggered by a malformed row | reproduced from request shape; scanning the fixture finds no value copied from the source record (US5, SC-010) |
| 47 | Order is enforced | make request-shape fail to reproduce | synthetic is attempted next, anonymised last — never reordered (FR-024) |
| 48 | Grant required | request an anonymised extract with no grant | refused with `GRANT_REQUIRED`; `grant_ref` is a not-null constraint in that mode |
| 49 | Raw payload refused | attempt to copy a production payload into a fixture | refused in every mode (FR-024) |
| 50 | Scanner blocks | plant a secret pattern in a candidate fixture | blocked before use; the finding is raised (FR-025) |
| 51 | No fixture store | search the schema for fixture contents | no such column exists, in any mode (C-04, R-06) |
| 52 | The recipe crosses, the data does not | reproduce at `data`, then read what 008 receives | field shapes / generator parameters and a seed — no values |
| 53 | Anonymised has no recipe | reproduce only via an anonymised extract | `recipe` is null; the handoff says 008 attempts a synthetic equivalent and takes `NO_RECIPE` to a human if it does not reproduce (R-06, C-23) |

### Running an arbitrary project's tests

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 54 | Discovery | point the adapter at a supported repository | command, working directory and report format resolved and recorded (FR-018) |
| 55 | Structured reports only | search the adapters for a stdout parser | none exists; an adapter that cannot request a report declares `unsupported` (R-10) |
| 56 | Unparseable is not `PASS` | corrupt the report file | `INCONCLUSIVE` / `unparseable_output` with the parse failure as evidence (FR-019) |
| 57 | Missing report is distinguished | exit non-zero with no report | recorded differently from parsed failing tests (FR-020 edge case) |
| 58 | Truncated report | cut the report mid-file | `unparseable` — not "zero tests" |
| 59 | Empty selector | select a pattern matching nothing | zero results, `INCONCLUSIVE`, never `PASS` |
| 60 | Tenant command | unsupported runner, tenant command configured | that command is used, with its declared report path (FR-020) |
| 61 | No command at all | unsupported runner, nothing configured | `INCONCLUSIVE` / `no_test_command`, naming the missing configuration |
| 62 | Conformance | run `make adapter-conformance` | every registered adapter passes all eight fixtures; an adapter without a suite is not registered |

### The expensive tests run somewhere else

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 63 | Delegation | require a full suite | CI triggered, waiting state persisted, **no worker job blocks** (FR-021, FR-022, SC-011) |
| 64 | Callback ingests | CI completes | results ingested as `test_result` evidence correlated to the requesting execution (FR-023) |
| 65 | Duplicate callback | deliver the same callback twice | `receivedCount` increments; nothing else changes |
| 66 | Callback never arrives | let the deadline pass | recorded timeout routed to a human — not an indefinite wait |
| 67 | Slow CI | induce a twenty-minute pipeline | the longest worker job stays within its declared wall clock (SC-011, 012 FR-027) |
| 68 | Unit scope stays local | run the unit rung | executed in the sandbox, not delegated (D-16) |

### Boundary and tenancy

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 69 | Closed boundary | attempt to transmit a raw log body, a source file or a fixture payload | rejected by the boundary schema contract test (FR-026, SC-009, 012 FR-022) |
| 70 | Denials cross as a known shape | inspect the transmitted evidence for a prefetch denial and for scenario 29's recorded egress posture | both cross as `tool_output_summary`, not as a new top-level shape (R-17, R-19) |
| 71 | Tenant isolation | read another tenant's execution, ladder, fixture record and delegation | 404 on every one (SC-012) |
| 72 | Callback isolation | replay a delegation callback with another tenant's token | 404 — never a 403, which would confirm existence |
| 73 | Audit | take a run from a month ago | its evidence links, agent run and tool calls all resolve (FR-029, 012 FR-033) |
| 74 | Repeat counts have a floor | configure a rung's repeat count below the product floor | refused — one flaky `PASS` would otherwise become a reproduction the whole fix chain rests on (FR-031) |

## Invariant checks (run continuously, not only in tests)

```bash
npm run check:change-gate          # no change plan without a FAIL reproduction (SC-001)
npm run check:ladder-monotonic     # no rung attempted above the reproducing rung (SC-002)
npm run check:no-pass-laundering   # timeout, build failure, unparseable, absent report ≠ PASS (SC-006)
npm run check:workspace-destroyed  # no workspace outlives its grace period (SC-005)
npm run check:credential-scans     # every run has a clean pre-run scan (SC-004)
npm run check:fixture-contents     # no fixture contents anywhere, any mode (SC-010, C-04)
npm run check:no-blocked-jobs      # no worker running while a CI delegation is pending (SC-011)
```

## Release gate

```bash
make eval -- --metric reproducible-share    # SC-008: share of golden-dataset incidents reproducible
                                            # at any rung. This is the number that sizes the product
                                            # (stage 0, S0-1). A fall below the stage-0 threshold is
                                            # a scope signal, not a bug — see incident-taxonomy.md
make eval -- --metric rung-distribution     # where reproductions actually land; drives rung tuning
```

Real and synthetic incidents are never combined into one figure (C-05). Determinism is checked
separately: repeating a reproduction at the same commit for a deterministic class yields the same
rung and result in ≥ 99% of repeats (SC-007).
