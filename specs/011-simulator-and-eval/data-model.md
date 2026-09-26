# Data Model: historical replay and the benchmark

Schema `eval`. Tables this feature owns. `Issue`, `Evidence` and `AuditEntry` belong to 001,
`PolicyDecision` to 002, `Component` to 004, `ExpectedBehavior` to 005, reproduction records to 007,
change plans and verdicts to 008, and `prompt_version`, `agent_run`, `workflow_run` and
`tenant_budget` to 012 — referenced here, never redefined. Cost is read from `agent_run` by
correlation identifier; there is no second cost counter (012 FR-036, VIII).

Identifiers are UUID v7; timestamps `timestamptz` UTC. Every table carries `tenant_id` with an
index `(tenant_id, …)` ([prisma rules](../../.claude/rules/prisma-migrations.md)).

## golden_issue

A dataset entry. Holds references and closed evidence shapes — **no customer source, no free-form
incident text** (R-10, C-04).

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| component_id | uuid? | `Component` (004) |
| title | text | short label, human-written at import |
| signature | jsonb | `error_signature` shape (012 FR-022) |
| fingerprint | text | computed with 001's ruleset; links an entry to live recurrences |
| context_bundle | jsonb | closed evidence shapes only; a field outside the schema rejects the entry |
| repo_ref | text | repository identifier — resolved in the execution plane |
| commit_sha | text | the state to reproduce from |
| bundle_digest | text? | when replay uses a customer-produced export that stays in their plane |
| historical_outcome | jsonb | what was actually done and observed; the ground truth |
| fix_ref | text? | fix commit SHA — **provenance only; never an input to scoring** (R-06) |
| incident_class | enum | `deterministic` · `load_dependent` · `data_specific` · `concurrency` · `third_party` · `config` (S0-1) |
| was_code_bug | bool? | sizes the classifier's task (006 FR-001) |
| reproducibility_class | enum | `reproducible` · `partially` · `not_reproducible` · `unknown` |
| origin | enum | `real` · `synthetic` — **mandatory, no default** (FR-011, C-05) |
| split | enum | `dev` · `benchmark` — **mandatory, no default, never updated** (FR-011a, R-19) |
| synthetic_injection | jsonb? | for `synthetic`: the bug injected and the real commit it was injected into |
| runnable | bool | false once repo state or context is unrecoverable (FR-012) |
| imported_at, imported_by | | |

Index `(tenant_id, origin)`, `(tenant_id, fingerprint)`, `(tenant_id, split)`.

`split` sits on the entry and not on `dataset_entry` membership deliberately. Whether an incident has
ever been available to prompt iteration is a property of the incident, not of a dataset version —
membership-level split would let the same incident be published as `dev` in version 3 and `benchmark`
in version 4, which is how a tuned-on entry gets laundered into the set that justifies raising
autonomy (R-19).

## dataset_version (immutable)

`id`, `tenant_id`, `name`, `version` int, `entry_count`, `synthetic_count`, `real_count`,
`published_at`, `published_by`, `composition` jsonb (class, reproducibility and **split** breakdown).

`synthetic_count` and `real_count` are **computed at publication** from member entries and frozen.
Neither is settable (R-04). Unique `(tenant_id, name, version)`. Never updated; a change is a new
version, and prior runs keep referencing the version they used (FR-019).

## dataset_entry

Membership. `dataset_version_id`, `golden_issue_id`, `tenant_id`. PK both ids. Entries are reusable
across versions, which is why membership is its own table rather than a column on `golden_issue`.

## run_configuration (immutable)

The pinned set; two runs are comparable when their digests agree.

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| digest | text | hash over every field below; unique per tenant |
| model_id, model_version | text | resolving either to nothing fails the run (FR-008) |
| routing | enum | `evaluation_shared` · `tenant_provider` — recorded, and part of the digest (R-14) |
| prompt_version_ids | uuid[] | 012 `prompt_version`; resolved by id, never by key (R-13) |
| dataset_version_id | uuid? | null for a single-issue simulation |
| split_filter | enum | `dev` · `benchmark` · `none` — which split this run draws from; **part of the digest** (R-19) |
| policy_rule_version | int | 002 FR-004 |
| retrieval_snapshot_id | text | 005 |
| scoring_version | int | a change is a new run, never a rescore in place |
| adapter_versions | jsonb | |
| budget | jsonb | per-run spend and time (002 FR-011) |
| temperature, seed | | zero and fixed where the provider supports it (R-03) |

## simulation_run

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| configuration_id | uuid | |
| kind | enum | `single_issue` · `dataset` — the only difference between the two purposes (FR-001) |
| capability_set | text[] | recorded as granted; contains no mutating capability, and none can be added (R-01) |
| workflow_run_id | uuid | 012 |
| completion_state | enum | `running` · `complete` · `partial` · `failed` |
| reproducibility | enum | `unverified` · `reproducible` · `non_reproducible` (R-03) |
| diverging_component | text? | set with `non_reproducible` (FR-007) |
| scored_count, real_scored_count, synthetic_scored_count, unrunnable_count | int | `synthetic_scored_count` counts what was **scored**, not what the dataset held (R-04) |
| split_scope | enum | `dev` · `benchmark` · `mixed` — **computed from the entries actually scored**, never set by the caller; `split_filter` is intent, this is outcome (R-19) |
| cost | numeric | summed from `agent_run` by correlation id (012 FR-036) |
| resume_cursor | uuid? | first unscored entry (R-12) |
| started_at, finished_at? | | |

Index `(tenant_id, configuration_id)`. Additionally **unique
`(id, synthetic_scored_count, completion_state, reproducibility, split_scope)`** — redundant given the
primary key, and there deliberately: it is the target of `threshold_derivation`'s composite foreign key,
which is what makes the four run facts copied onto a derivation row provably equal to the run's own
(R-04, R-19).

## run_report

Per input, whether or not it is scorable.

`id`, `tenant_id`, `run_id`, `golden_issue_id?`, `issue_id?` (for a read-only replay of a live
issue), `classification` (006 FR-012 outcome), `diagnosis` jsonb, `reproduction_outcome`
(`PASS` · `FAIL` · `INCONCLUSIVE`, 007 FR-004), `change_plan` jsonb?, `policy_decisions` jsonb
(dry-run evaluations with the rules that produced them, 002 FR-019), `stop_point` text,
`risk_classification` text, `cost`, `tokens_in`, `tokens_out`, `latency_ms`,
`evidence_ids` uuid[], `unrunnable_reason` text?.

`stop_point` is first-class output: "would have required approval, grant missing for component X"
is a result, not an error (FR-003).

## score and score_criterion

`score`: `id`, `tenant_id`, `run_id`, `golden_issue_id`, `verdict`
(`success` · `false_fix` · `no_fix` · `unscored`), `applicable_count`, `scoring_version`,
`scored_at`.

`score_criterion`: `score_id`, `criterion` (`regression_test_passes` ·
`original_failure_not_reproducible` · `pre_existing_suite_passes` · `no_unintended_change` ·
`incident_did_not_recur`), `result` (`pass` · `fail` · `not_applicable`), `anchor_kind`
(`historical_outcome` · `pre_existing_suite` · `raw_evidence` · `adopted_expectation` ·
`production_observation`), `anchor_ref`, `reason`.

There is **no similarity criterion and no field that could hold one**; the scoring input type does
not include `fix_ref` or any diff (R-06, FR-014, SC-005).

## run_metric

| Field | Type | Rules |
|-------|------|-------|
| run_id, metric, cohort | | PK. `cohort` is `real` or `synthetic` — **there is no `combined`** (R-05, C-05) |
| tenant_id | uuid | |
| value | numeric? | null whenever `availability <> 'available'` |
| numerator, denominator | int | both always stated (FR-016) |
| exclusions | jsonb | which entries were excluded and why (FR-012) |
| availability | enum | `available` · `insufficient_observation` · `not_applicable` (R-09) |
| availability_reason | text? | e.g. "no tenant has run at L2 for thirty days" |

Metrics: `diagnosis_accuracy`, `reproduction_rate`, `first_attempt_fix_rate`, `iterations_to_green`,
`unintended_changes`, `tokens`, `latency`, `cost_per_resolved_issue`, `false_fix_rate`,
`revert_rate_30d`.

## revert_observation

Attribution of a production revert back to the run that produced the change (FR-018).

`id`, `tenant_id`, `run_id`, `golden_issue_id?`, `change_ref` (merge commit or MR), `merged_at`,
`window_closes_at`, `reverted` bool?, `revert_ref` text?, `observed_at?`.

Written by a scheduled reconciliation over changes whose thirty-day window has closed. No job waits
(R-09, 012 FR-025). A row with `observed_at is null` is a window still open and contributes to
neither numerator nor denominator.

## threshold_derivation

The C-05 enforcement point (R-04).

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| threshold_key | enum | `false_fix_rate` · `per_incident_cost_ceiling` · `tenant_daily_budget` · `escalation_attempt_cap` |
| value | numeric | |
| run_id | uuid | FK `simulation_run` |
| dataset_version_id | uuid | |
| metric | text | which `run_metric` justifies it |
| real_denominator | int | the **scored** real denominator for that metric, not the dataset size |
| run_synthetic_scored_count | int | **copied from the run at insert** (R-04) |
| run_completion_state | enum | copied from the run at insert |
| run_reproducibility | enum | copied from the run at insert |
| run_split_scope | enum | copied from the run at insert (R-19) |
| artifact_digest | text | digest of the exported derivation artifact CI resolves (FR-021c, R-20) |
| derived_by, derived_at | | |
| superseded_by_id | uuid? | change history; rows are never edited (002 FR-020) |

The four run facts are **denormalised onto this row** because a Postgres `CHECK` constraint cannot
read another table: written as constraints "on the referenced run" they would simply not exist, and
C-05's enforcement mechanism would be a comment (R-04). What makes the copies trustworthy is a
composite foreign key rather than a trigger:

```sql
-- the copies cannot disagree with the run they name
FOREIGN KEY (run_id, run_synthetic_scored_count, run_completion_state,
             run_reproducibility, run_split_scope)
  REFERENCES simulation_run (id, synthetic_scored_count, completion_state,
                             reproducibility, split_scope)

-- and, being local columns now, these are enforceable
CHECK (run_synthetic_scored_count = 0)          -- C-05: no synthetic material anywhere in the run
CHECK (run_completion_state = 'complete')       -- a partial run cannot back a threshold (R-12, FR-023)
CHECK (run_reproducibility = 'reproducible')    -- an unrepeatable run justifies nothing (R-03)
CHECK (run_split_scope = 'benchmark')           -- nothing tuned on may justify autonomy (R-19, FR-021b)
CHECK (real_denominator >= 20)                  -- min_real_yield, written as a literal (R-15, SC-011)
```

A run whose state later changes cannot leave a stale derivation behind: the referenced tuple no longer
exists, so the update is refused unless the derivation is dealt with first. That is the point of the
composite key — an ordinary `FOREIGN KEY (run_id)` would let a `complete` run be re-marked `partial`
under a threshold that still cites it.

`min_real_yield` is a **product constant of 20** (R-15), not a symbol resolved at runtime and not
tenant configuration: the migration writes the literal, and the constant in code carries the same value
with a test asserting they agree. A `CHECK` cannot call a function that reads configuration, and that
limitation is the desired one here — the same argument as 002's `ACTION_CEILING`.

Absence of a row is the designed outcome when real yield is too small. Nothing records "no
threshold"; the ceiling simply holds.

## Not tables

- **RunComparison** is a query over two runs sharing `dataset_version_id` and `scoring_version`,
  returning per-issue verdict deltas (FR-020). Storing it would be a cache of a join.
- **RemediationHistory-style aggregates** and per-run rollups are queries over `score` and
  `run_metric`.
- **Cost** is summed from 012's `agent_run`, never counted here (VIII).

## Invariants

- No `threshold_derivation` row exists whose run scored a synthetic entry, was partial, or was not
  verified reproducible — enforced by local `CHECK`s over copied columns plus the composite foreign key
  that keeps the copies equal to the run's own values (C-05, SC-009, R-04).
- No `threshold_derivation` row exists with `real_denominator < 20`, and no configuration path can
  lower that bound: it is a literal in the migration and a constant in code (R-15, SC-011).
- No `threshold_derivation` row exists whose run scored a `dev` entry — `split_scope` is computed from
  what was scored and the `CHECK` admits only `benchmark`, so a run that touched tuning material cannot
  back a threshold and cannot be re-marked afterwards without dealing with the derivation (R-19, SC-012).
- `golden_issue.split` is never null, never defaulted and never updated; a reclassification is a new
  entry, so an incident cannot move into the benchmark set after it was tuned on (FR-011a, R-19).
- Every `threshold_derivation` row has an exported artifact whose digest matches `artifact_digest`, and
  every committed derivation artifact resolves to a row — reconciled continuously, not only in CI
  (FR-021c, R-20).
- No `run_metric` row has `cohort = 'combined'`; the value is not in the enum (C-05).
- `golden_issue.origin` is never null and never defaulted (FR-011).
- `dataset_version.synthetic_count` equals the count of `origin = 'synthetic'` members at
  publication, and neither the version nor its membership changes afterwards.
- Every `run_report` conclusion has at least one `evidence_link` emitted by its producing step
  (001 FR-008, FR-009, FR-027).
- `simulation_run.capability_set` contains no mutating capability, verified by the attempt matrix
  (SC-001) and by a continuous check.
- A run whose configuration cannot resolve every `prompt_version_id` and its model version does not
  start (FR-008).
- Every read is constrained by `tenant_id` from the authenticated context; a comparison whose two
  runs belong to different tenants is unrepresentable in the query (FR-024, SC-010).
