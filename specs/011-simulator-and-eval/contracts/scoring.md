# Contract: scoring, cohorts and threshold derivation

Normative. The scoring definition is versioned; changing it is a new `scoring_version`, and prior
runs are never rescored in place — a rescore is a new run (FR-019).

## The scoring input

```text
ScoringInput
  proposal      { changePlan, regressionTest, impactAnalysis, gateResults, verdict }
  groundTruth   { historicalOutcome, preExistingSuiteRef, reproductionResult,
                  recurrenceObservation? }
  entry         { id, componentId, commitSha, incidentClass, reproducibilityClass, origin }
```

`groundTruth` **does not contain the human patch**, and the scorer never fetches it. `fix_ref` is
stored on the dataset entry for a human reading the case and is not a field here (R-06). SC-005's
check inspects this type: a similarity metric cannot be computed against data the function was never
given, which is a stronger guarantee than a rule against writing one.

## The five criteria

Each resolves to `pass`, `fail` or `not_applicable`, and records the anchor it used. Every anchor
pre-dates the run or is raw evidence; none is an artifact the same run produced (FR-015,
constitution II).

| Criterion | Passes when | Anchor | `not_applicable` when |
|---|---|---|---|
| `regression_test_passes` | the run's regression test passes on the changed commit in the sandbox (008 FR-011) | the test, executed — plus the adopted `ExpectedBehavior` its assertion traces to (008 FR-006) | the run produced no change plan |
| `original_failure_not_reproducible` | the reproduction that previously returned `FAIL` no longer reproduces the issue's signature (007 FR-004, FR-005) | the pre-change reproduction result | the entry was never reproducible |
| `pre_existing_suite_passes` | every test passing on the pre-change baseline still passes (008 FR-012) | the human-written suite at the entry's commit | no suite exists at that commit |
| `no_unintended_change` | 008's deterministic impact analysis finds no behavioural change outside the change plan (008 FR-001, FR-003) | the deterministic change graph | repo state unrecoverable |
| `incident_did_not_recur` | no matching fingerprint observed for the recurrence window after the change was merged | production observation | **always, for a replayed historical entry** — nothing was merged, so nothing could recur (R-07) |

## Verdicts

```text
success     every applicable criterion passes
false_fix   the run's gates all passed — RED, GREEN, pre-existing suite, verifier APPROVE
            (008 FR-009, FR-017) — and at least one applicable criterion failed
no_fix      the run did not reach an approved change, or a gate rejected it
unscored    fewer than two applicable criteria
```

`unscored` entries are excluded from every denominator and the exclusion is reported (FR-012). They
are never counted as failures.

**Never a criterion**: textual or structural similarity to the historical patch (FR-014); the number
of lines changed; model-reported confidence (FR-028, 002 FR-003). Confidence is recorded alongside
the score for calibration analysis and is never read by a predicate.

## Cohorts

Metrics are keyed by `(run, metric, cohort)` with `cohort ∈ {real, synthetic}`. **There is no
`combined` cohort.** A caller must name one; a report showing both shows two labelled numbers and
the synthetic share (FR-011, C-05, R-05).

Every metric states its numerator, its denominator and its exclusions (FR-016, SC-007).

| Metric | Denominator |
|---|---|
| `diagnosis_accuracy` | entries with a recorded historical root cause |
| `reproduction_rate` | entries with recoverable repo state |
| `first_attempt_fix_rate` | entries that reached a change plan |
| `iterations_to_green` | entries that reached `success` |
| `unintended_changes` | entries where impact analysis ran |
| `tokens`, `latency` | all scored entries |
| `cost_per_resolved_issue` | entries with verdict `success`; cost from 012 `agent_run` |
| `false_fix_rate` | entries whose gates all passed |
| `revert_rate_30d` | merged changes whose thirty-day window has closed |

## Availability

A metric carries `availability ∈ {available, insufficient_observation, not_applicable}` with a
nullable value.

`revert_rate_30d` is `insufficient_observation` — **not zero, and not omitted** — until a tenant has
run at L2 or above long enough for at least one merged change's window to close, with the reason
stated (R-09). A revert rate rendered as 0% because nothing has been observed is the most flattering
reading available and would be quoted as evidence for L3.

## Threshold derivation (C-05)

A `threshold_derivation` row may be written only when **every** condition holds on the run it cites:

```text
run_synthetic_scored_count = 0          no synthetic incident anywhere in the run
run_completion_state       = complete   a partial run cannot back a threshold (FR-023)
run_reproducibility        = reproducible   a run nobody can repeat justifies nothing (FR-007)
real_denominator          >= 20         min_real_yield, a product constant (R-15)
cohort                     = real
```

These are database check constraints, not validation in a command handler (R-04) — and the first three
name **columns of the derivation row itself**, copied from the run at insert. A `CHECK` in Postgres
cannot read another table, so a constraint written against `simulation_run.completion_state` would not
exist at all; the copies are kept honest by a composite foreign key onto
`simulation_run (id, synthetic_scored_count, completion_state, reproducibility)`, so a derivation cannot
carry values the run does not have, and a run cannot later change them under a derivation that cites it.

`min_real_yield` is **20**, a product constant (R-15): the literal is written into the migration and no
configuration path can lower it. The record names the run, the dataset version, the metric, the value
and the real denominator, and a change to a threshold is audited with the prior value and the run
supporting the new one (FR-021, 002 FR-020).

**When the real yield is too small, no derivation row exists and the L2 ceiling stands.** That is
the designed outcome, not a failure — nothing records "no threshold", the ceiling simply holds
(C-05, constitution Governance).

A completed run whose metrics contradict a threshold in effect raises a conflict against that
derivation rather than letting the threshold stand silently (FR-022).

## Comparison

Two runs are comparable when their `dataset_version_id` and `scoring_version` agree; model and
prompt version are what may differ (FR-020). The comparison reports per-issue verdict deltas in both
directions, and any entry moving `success → false_fix` is reported independently of the aggregate
direction — an aggregate improvement that hides a new false fix is a regression (US7).

A comparison whose two runs belong to different tenants is refused (FR-024).

## Reproducibility

A run starts `unverified`. Repeating the identical configuration digest and obtaining identical
**behavioural scores** — not identical text — promotes it to `reproducible`. Any divergence marks it
`non_reproducible` and names the diverging component (FR-007, R-03). Only a `reproducible` run may
back a threshold.

A run whose pinned model version or prompt version cannot be resolved fails explicitly and never
substitutes another (FR-008).
