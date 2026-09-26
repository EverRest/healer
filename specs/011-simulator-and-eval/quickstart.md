# Quickstart: historical replay and the benchmark

```bash
make bootstrap
make test -- --testPathPattern domain/evaluation
make test-e2e -- --testPathPattern 011-          # includes the mutation attempt matrix
make eval                                        # the benchmark; a release gate, not part of ci
```

`make eval` is deliberately outside `make ci` (012 `contracts/make-targets.md`): it costs model
spend and needs the golden dataset. It runs on release candidates and on any change to prompts,
agents or policy.

## Scenarios

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 1 | Twenty incidents, nothing connected | import an export, run the runner image locally, replay | complete reports, no integration connected, no credential granted (SC-008, R-11) |
| 2 | Report completeness | read one report | diagnosis, reproduction outcome, change plan, every policy decision with its rules, risk, cost and the stop point (FR-002) |
| 3 | Refusal is output | replay an incident the tenant's grants would refuse | the refusal and the missing grant appear as first-class output, not an error (FR-003) |
| 4 | Policy is not re-implemented | trace the policy call inside a run | 002's dry-run evaluation (002 FR-019); no second rule engine exists |
| 5 | Evidence behind every conclusion | take any claim in a report | resolves to evidence records emitted by the producing step (001 FR-008, FR-009) |
| 6 | **Attempt matrix** | from inside a run, attempt every mutating operation in the product | each is unreachable; refusals recorded; 0 mutations (SC-001, FR-004) |
| 7 | Not a flag | grep the mutation call sites for a run-type branch | none — the capability is an argument the run does not hold (R-01) |
| 8 | No grantable capability | try to configure a simulation run with repository write | no field exists to carry it, and the broker has no such principal grant (SC-002, FR-005) |
| 9 | Shared code path | follow a path used by both simulation and live execution to a mutation | gated by capability, not by run type (US2) |
| 10 | Sandbox hygiene | inspect a run's sandbox | no production credentials, default-deny egress, destroyed afterwards (FR-026, 007 FR-011..014) |
| 11 | Live issue replay | simulate against a currently open issue | read-only over live evidence; produces a plan; never joins the live workflow |
| 12 | **Better fix scores as success** | score a behaviourally correct fix structurally unlike the human patch | `success` (US3, FR-014) |
| 13 | **Lookalike fix scores as false fix** | score a fix resembling the human patch that leaves the failure reproducing | `false_fix` (US3) |
| 14 | Scorer never sees the patch | inspect the scoring input type | no diff, no `fixRef`; a similarity metric cannot be written against absent data (SC-005, R-06) |
| 15 | Anchors | check each criterion's anchor | historical outcome, pre-existing suite, raw evidence or adopted expectation — never an artifact the same run produced (FR-015) |
| 16 | Recurrence is not faked | score a replayed historical entry | `incident_did_not_recur` is `not_applicable` with the reason, not a pass (R-07) |
| 17 | Too few criteria | score an entry where only one criterion applies | `unscored`, excluded from denominators — not a failure (FR-012) |
| 18 | Seeded false fixes | run a benchmark seeded with known false fixes | reported rate matches the seeded count exactly (SC-006) |
| 19 | False fix inspectable | open a false fix | gates passed, evidence used, model and prompt version all retrievable (FR-017) |
| 20 | **Revert rate is not zero** | request `revert_rate_30d` with no L2 tenant history | `insufficient_observation` with the reason; never `0` and never omitted (R-09) |
| 21 | Revert attribution | revert a merged Healer change on day 12 | attributed to the producing run and counted once the window closes (FR-018) |
| 22 | Reproducibility earned | run the same pinned configuration twice | identical behavioural scores → `reproducible`; divergence names the component (FR-007, SC-003) |
| 23 | Missing pinned version | delete the pinned model version, re-run | fails explicitly; no substitution (FR-008) |
| 24 | Prompts by id only | configure an agent to resolve a prompt by path | the run refuses to start (R-13, 012 FR-038) |
| 25 | Routing recorded | run for a Healer-provided tenant and for a BYO tenant | routing recorded in run metadata; **the BYO tenant's run never reaches the Healer-managed provider** (FR-009, 012 FR-046, 012 SC-016, R-14) |
| 26 | Production path isolation | try importing the evaluation router outside the evaluation package | `lint` fails on the boundary pattern (012 FR-003) |
| 27 | Synthetic labelled | report over a mixed dataset | every metric is per cohort with the synthetic share stated (FR-011, SC-007) |
| 28 | **No combined figure** | request a metric without a cohort | rejected — `cohort` is required and has no `combined` member (C-05, R-05) |
| 29 | **C-05 is a constraint** | derive a threshold from a run that scored one synthetic entry | refused by a check constraint, not by a handler (SC-009, R-04) |
| 30 | Partial cannot derive | exhaust the budget mid-dataset, then derive | run suspends `partial` and resumes; derivation refused (FR-023, R-12) |
| 31 | Non-reproducible cannot derive | mark a run `non_reproducible`, then derive | refused (R-03) |
| 32 | Denominator, not dataset size | 25 entries, 8 unrunnable, derive a threshold | refused — the scored real denominator is 17, below the minimum (R-04, SC-011) |
| 33 | No threshold is the answer | real yield too small | no derivation row exists; the L2 ceiling stands and nothing records "no threshold" (C-05) |
| 34 | Threshold provenance | ask why a threshold is what it is | resolves to a run, dataset version and metric (SC-009, FR-021) |
| 35 | Threshold change audited | change a threshold | who, prior value, and the run supporting the new one (002 FR-020) |
| 36 | Conflict surfaced | complete a run whose results contradict a threshold in effect | the conflict is reported; the threshold does not stand silently (FR-022) |
| 37 | Per-issue comparison | run old and new prompt versions over one dataset version | per-issue deltas both directions; `success → false_fix` highlighted regardless of the aggregate (FR-020) |
| 38 | Comparison guards | compare across dataset versions, scoring versions, or tenants | refused in all three cases (FR-020, FR-024) |
| 39 | Dataset immutability | change the dataset | new version; prior runs still reference theirs (FR-019) |
| 40 | Unrunnable entry | delete the repo state for an entry, run | reported unrunnable and excluded from the denominator — not scored as a failure (FR-012) |
| 41 | Environment failure | make an entry's dependencies uninstallable | reported as an environment failure, distinct from a Healer miss (edge case) |
| 42 | Import rejects, never cleans | import an entry with a free-form log body field | rejected `UNREDACTED_FIELD`; nothing stored (FR-025, R-10) |
| 43 | No source at rest | inspect what the control plane holds for an entry | references and closed shapes; no customer source (R-10, C-04) |
| 44 | Confidence is not a gate | seed reports with high and low reported confidence | identical scores; confidence recorded only for calibration (FR-028, 002 FR-003) |
| 45 | Cost is measured | compare a benchmark cost to a live cost | both summed from the same `agent_run` accounting (012 FR-036) |
| 46 | Tenant isolation | read another tenant's entries, runs, reports, metrics and thresholds | 404 on every one (SC-010) |
| 47 | Never wait in a job | inspect the dataset run and the 30-day reconciliation | persisted state and scheduled reconciliation; `lint` fails on a sleep in a processor (012 FR-025, 012 FR-026) |
| 48 | Stage-0 gate | attempt to derive a threshold before 20 scored real incidents | refused (SC-011) |
| 49 | The sealed set stays sealed | update a `golden_issue` from `dev` to `benchmark`, by repository and by raw SQL | both refused; reclassification is a new entry (FR-011a, R-19) |
| 50 | Tuning material justifies nothing | derive a threshold from a run that scored one `dev` entry; then re-mark a cited run's scope | refused by check constraint including direct SQL; the re-mark is refused while a derivation cites the run (FR-021b, SC-012) |
| 51 | A ceiling raise has provenance | publish a derivation, then check out the repository with no database access and resolve the artifact | the committed artifact resolves; digest matches the row; an artifact with no row fails the reconciliation (FR-021c, SC-013) |

## Invariant checks (run continuously, not only in tests)

```bash
npm run check:run-capabilities      # no run context holds a mutating capability (SC-001)
npm run check:no-combined-cohort    # no metric row outside {real, synthetic} (C-05)
npm run check:threshold-eligibility # every derivation cites a complete, reproducible, real-only run
npm run check:scoring-input         # the scoring input type carries no patch or diff (SC-005)
npm run check:derivation-artifacts  # committed artifacts and rows agree in both directions (SC-013)
```

## Feeding stage 0

A benchmark run is the input to [S0-3](../../docs/stage-0.md): `false_fix_rate`,
`per_incident_cost_ceiling`, `tenant_daily_budget` and `escalation_attempt_cap` each become a
`threshold_derivation` row naming the run, the dataset version, the metric and the real denominator
— or they remain underived, and the L2 ceiling holds.
