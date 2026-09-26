# Data Model: reproduction and sandbox

Schema `reproduction`. Identifiers are UUID v7; timestamps `timestamptz` UTC. Every table carries
`tenant_id` with an index `(tenant_id, …)` ([prisma rules](../../.claude/rules/prisma-migrations.md)).

Tables owned elsewhere and only referenced here: `issue.issue`, `evidence.evidence`,
`evidence.evidence_link`, `audit.audit_entry` (001); `workflow_run`, `workflow_callback`,
`runner_registration`, `agent_run` (012); `diagnosis.diagnosis`,
`diagnosis.reproduction_directive` (006); policy grants (002).

## reproduction.ladder_rung (reference data, frozen order)

| Field | Type | Rules |
|-------|------|-------|
| key | text | PK. Server ladder: `unit` · `request` · `data` · `concurrency` · `load` · `external_state`. Client ladder: `client_unit` · `client_request` · `client_journey` (R-22) |
| ladder | enum | `server` · `client` — which ladder this rung belongs to |
| rung_order | int | unique **within a ladder**. The climb is `order by rung_order` inside the selected ladder, stopping at the first reproduced |
| repeat_policy | enum | `single_plus_confirm` · `repeat_n` (`concurrency`, `load`, `client_journey`) · `single` |
| default_wall_clock_s | int | ceiling for one attempt at this rung |
| requires_fixture | bool | true for `data` |
| requires_declared_reason | bool | true for `client_journey` only — the most expensive rung in the product, refused when a cheaper rung on its ladder was never attempted (R-23) |

Unique `(ladder, rung_order)` and unique `(ladder, key)`.

Frozen in [contracts/ladder.md](contracts/ladder.md), which is normative. **The ladder used is
selected by the directive's `observable_location` (006 R-20), never by `issue.kind`** — a client-only
symptom cannot produce a `FAIL` at `unit` or `request` in principle, so climbing them would waste two
rungs by construction. 006 imports the vocabulary; adding a rung is a data change plus a contract
version bump (R-01).

## reproduction.reproduction_attempt

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | FK `issue.issue` |
| diagnosis_id | uuid | FK 006 — which diagnosis version this attempt tests |
| directive_id | uuid | FK 006 `reproduction_directive` |
| ladder | enum | `server` · `client`, from the directive's `observable_location` (R-22) |
| max_rung | text | FK `ladder_rung`; the ceiling from the directive, on this ladder (006 R-13) |
| result | enum | `PASS` · `FAIL` · `INCONCLUSIVE` |
| inconclusive_reason | enum? | required when `INCONCLUSIVE`; closed set (R-05) |
| reproducing_rung | text? | FK `ladder_rung`; non-null exactly when `result = 'FAIL'` |
| observed_runs | int | copied from the reproducing rung's `rung_attempt` row (R-18) |
| reproduced_runs | int | copied from the same row — never summed across rungs (R-18) |
| intermittent | bool | derived: `reproduced_runs < observed_runs` (R-04) |
| observed_rate | numeric | `reproduced_runs / observed_runs`; carried to 008 (FR-007) |
| budget_consumed | jsonb | wall clock and spend, reconciled against 002 |
| handoff_ref | uuid? | set for every `INCONCLUSIVE` (FR-006) |
| started_at, finished_at | timestamptz | |

`inconclusive_reason` closed set:
`no_rung_reproduced` · `signature_mismatch` · `build_failure` · `environment_failure` · `timeout` ·
`unparseable_output` · `no_test_command` · `commit_unavailable` · `budget_exhausted` ·
`capability_refused` · `observable_location_undetermined` (R-22 — the directive could not say which
ladder applies, and guessing costs a browser run to learn nothing) · `browser_unavailable` (the
client ladder's top rung needs a frontend build and browsers the runner does not have).

Checks: `reproducing_rung IS NOT NULL` **iff** `result = 'FAIL'`;
`inconclusive_reason IS NOT NULL` **iff** `result = 'INCONCLUSIVE'`;
`handoff_ref IS NOT NULL` when `result = 'INCONCLUSIVE'`.

Index `(tenant_id, issue_id, started_at desc)`.

## reproduction.rung_attempt (append-only)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| attempt_id | uuid | FK |
| rung_key | text | FK `ladder_rung` |
| outcome | enum | `reproduced` · `not_reproduced` · `skipped` · `error` |
| skip_reason | enum? | required when `skipped`: `preconditions_unavailable` · `above_max_rung` · `no_entry_point` · `no_harness` · `grant_absent` · `budget_exhausted` (R-03) |
| error_detail | jsonb? | required when `error` |
| observed_runs | int | repeats actually run at this rung under its `repeat_policy` (R-18); 0 for a skip |
| reproduced_runs | int | of those, how many reproduced (R-18) |
| execution_run_id | uuid? | null for a skip — nothing executed |
| duration_ms | int | |
| resource_cost | jsonb | cpu seconds, peak memory, disk |
| occurred_at | timestamptz | |

Unique `(attempt_id, rung_key)` — one record per rung per attempt, and every rung at or below the
reproducing rung has one. A rung above the reproducing rung has **no row**, which is what SC-002
reconciles: no rung above the reproducing rung was attempted.

`skipped` and `error` are distinct from `not_reproduced` on purpose (R-03) — only
`not_reproduced` is evidence.

The repeat counters live **here**, per rung (R-18). The attempt-level `observed_runs`,
`reproduced_runs` and `observed_rate` are a **copy of the reproducing rung's row**, never an
aggregate across rungs: 10-of-10 at `data` and 0-of-2 at `unit` is not "10 of 12", and the only rate
008 can use is the one from the rung its regression test will run at.

## reproduction.execution_run

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK — **the immutable execution identifier** (FR-013) |
| tenant_id | uuid | |
| runner_id | uuid | FK 012 `runner_registration` |
| state | enum | `queued` · `starting` · `running` · `completed` · `killed` · `failed` (R-12) |
| commit_sha | text | the exact commit checked out (FR-015) |
| base_image_digest | text | |
| lockfile_digest | text? | generated by prefetch where absent (R-14) |
| resolved_dependencies | jsonb | name → resolved version |
| sandbox_profile_version | int | FK `sandbox_profile` |
| declared_limits | jsonb | copied from the profile at start |
| observed_usage | jsonb | cpu, peak memory, processes, open files, disk |
| exit_status | enum | `ok` · `test_failure` · `build_failure` · `limit_breach` · `timeout` · `infrastructure` |
| credential_scan_pre, credential_scan_post | enum | `clean` · `hit` — a `hit` aborts (R-09, FR-012) |
| egress_posture | jsonb | the run container's recorded posture: route table empty, resolver absent, allowlist digest. **This is what SC-003 checks** — there is no route, so there is no denial to capture (R-19, FR-011) |
| workspace_created_at, workspace_destroyed_at | timestamptz? | reconciled by SC-005's job |
| superseded_by | uuid? | FK self; a retry links back, results never merge (R-13) |
| queued_at, started_at, finished_at | timestamptz | |

Index `(tenant_id, state)`, `(workspace_destroyed_at) where workspace_destroyed_at is null`. There is
no `issue_id` column on this table — the issue is reached through `rung_attempt.attempt_id`, so a
per-issue lookup indexes `rung_attempt (tenant_id, execution_run_id)` instead.

No query aggregates across `id` values (R-13).

## reproduction.sandbox_profile (versioned, immutable)

`version` (PK), `cpu_millicores`, `memory_mb`, `max_processes`, `max_open_files`, `disk_mb`,
`wall_clock_s`, `egress_allowlist` text[] (prefetch phase only — the run container has none),
`mounted_paths` jsonb, `credential_policy` jsonb, `published_at`, `note`.

Never edited; a change is a new version, and every run records the version it used (FR-010, spec
Key Entities). The run container's absent route is a property of the image and the namespace, not a
row here — an empty allowlist would be a configuration that could be edited (R-08).

The allowlist is **per profile**, not per tenant: a tenant selects a profile version, and two tenants
on the same profile share the same registry allowlist. `note` is the publisher's reason for the
version, rendered wherever a profile version is shown — the run detail view and the handoff — so a
limit change a year old is still explicable.

## reproduction.egress_denial (append-only)

`id`, `tenant_id`, `execution_run_id`, `phase` enum (`prefetch` — the only value), `destination` text
(host or address as attempted — never a payload), `protocol`, `attempt_count`, `first_at`,
`last_at`.

**`phase` has one member on purpose.** Only the prefetch proxy can deny a destination, because only
the prefetch container has a route. The run container has none, `connect()` is not intercepted (R-19),
and its posture is recorded on `execution_run.egress_posture` instead. A `run`-phase row would be a
record of an interception that does not happen.

Crosses the plane boundary as a `tool_output_summary` evidence shape (R-17), as does the posture.
SC-003 reconciles against the red-team fixture in CI, against the recorded posture on every execution
record, and against the prefetch denial rows.

## reproduction.test_result

`id`, `tenant_id`, `execution_run_id`, `test_id`, `file_path`, `status` enum
(`passed` · `failed` · `skipped` · `errored`), `duration_ms`, `failure_message` (bounded, 001
FR-011), `failure_signature` jsonb (normalised), `source` enum (`sandbox` · `customer_ci`),
`ci_run_id` text?.

Keyed by execution id. A CI-sourced row carries the external run identifier (FR-023).

## reproduction.runner_adapter_resolution (append-only)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| execution_run_id | uuid | |
| repository_ref | text | |
| adapter_key | text? | null when unsupported |
| resolution | enum | `adapter` · `tenant_declared` · `unsupported` (FR-020) |
| command | text | resolved command, including the injected report flag (R-10) |
| working_directory | text | |
| report_format | enum | `junit_xml` · `runner_json` |
| report_path | text | |
| report_present | bool | distinguishes a parse failure from a missing report (FR-020 edge) |
| parse_outcome | enum | `parsed` · `unparseable` · `absent` |
| resolved_at | timestamptz | |

`parse_outcome` other than `parsed` forces `inconclusive_reason = unparseable_output`; it can never
produce `PASS` (FR-019, SC-006).

## reproduction.reproduction_fixture (metadata only — C-04)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| execution_run_id | uuid | |
| rung_key | text | `data` |
| construction_mode | enum | `request_shape` · `synthetic` · `anonymised` (FR-024, in that order) |
| content_digest | text | of what existed on the workspace tmpfs |
| scan_result | enum | `clean` · `blocked` — `blocked` prevents use and raises the finding (FR-025) |
| grant_ref | uuid? | **required** when `construction_mode = 'anonymised'` (FR-024, 002) |
| recipe | jsonb? | field shapes / generator parameters and seed; **null for `anonymised`** (R-06) |
| existed_from, destroyed_at | timestamptz | destroyed with the workspace |

**There is no contents column.** Healer retains no fixtures (C-04); what reaches 008 is `recipe`,
and an `anonymised` fixture has none, so 008 must synthesise or route to a human (R-06).

Check: `grant_ref IS NOT NULL` when `construction_mode = 'anonymised'`.

## reproduction.ci_delegation

`id`, `tenant_id`, `execution_run_id`, `suite_scope` enum (`full_suite` · `e2e`), `external_run_id`
text?, `workflow_callback_id` uuid (FK 012, kind `ci_result`), `deadline_at`, `state` enum
(`requested` · `running` · `completed` · `timed_out`), `received_count` int, `requested_at`,
`resolved_at`.

The wait is the callback plus the workflow run's `deadline_at` tick (ADR 0003, R-11). A duplicate
callback increments `received_count` and changes nothing else (FR-022). A deadline pass sets
`timed_out` and routes to a human — never an indefinite wait.

## reproduction.separate_defect_finding

`id`, `tenant_id`, `attempt_id`, `execution_run_id`, `observed_signature` jsonb,
`issue_signature` jsonb, `surfaced_at`, `raised_issue_id` uuid?.

Written when a run reproduces *a* failure that is not *the* failure (R-02, FR-005). The attempt is
`INCONCLUSIVE` with reason `signature_mismatch`; the finding is surfaced because it may be a second
bug.

## reproduction.change_eligibility (view — no write path)

```sql
-- eligible only for a recorded FAIL on the latest attempt; no attempt at all yields false with
-- blocked_by = {no_attempt}. The left join from issue is what makes that row exist to read.
select i.tenant_id, i.id as issue_id,
       coalesce(a.result = 'FAIL', false)                    as eligible,
       coalesce(a.intermittent, false) as intermittent, a.observed_rate, a.reproducing_rung,
       array_remove(array[
         case
           when a.id is null    then 'no_attempt'
           when a.result = 'PASS'         then 'not_reproduced'
           when a.result = 'INCONCLUSIVE' then a.inconclusive_reason::text
         end
       ], null)                                              as blocked_by
from issue.issue i
left join lateral (…latest attempt for i…) a on true;
```

Read by 008 — at fix-loop entry and again on the `→ REPRODUCED` guard (C-08) — and by the policy
engine (002 FR-001); 002 FR-005 turns an absent rule into `DENY`, so "no reproduction yet" and
"`PASS`" behave identically (R-16, FR-001). Composes with 006's `fix_eligibility`: two independent
views, both must hold, neither is writable. SC-001 reconciles change plans against this view
continuously.

`blocked_by` is an **array over a closed set** — `no_attempt`, `not_reproduced`, or one of the ten
`inconclusive_reason` values — the same shape 006's `fix_eligibility.blocked_by` returns, so a
consumer reading both views reads one shape. It carries at most one member today; the shape is what
matters.

## State transitions

```text
attempt:        started ──climb rung_order ascending──▶ first reproduced ──▶ FAIL (stop)
                started ──every rung ≤ max_rung exhausted──▶ PASS | INCONCLUSIVE
                any ──budget or attempt cap (002 FR-011, FR-013)──▶ INCONCLUSIVE, ladder preserved

execution_run:  queued ──capacity available──▶ starting ──▶ running ──▶ completed
                running ──limit breach──▶ killed (process tree)   ──▶ TIMEOUT ⇒ INCONCLUSIVE
                any exit path ──container exit──▶ workspace destroyed (R-07)
                failed ──retry──▶ new run id, superseded_by set, results never merged

ci_delegation:  requested ──▶ running ──callback──▶ completed
                requested | running ──deadline──▶ timed_out ⇒ human
```

## Invariants

- No code modification exists for an issue whose `change_eligibility.eligible` is false (SC-001).
- `result = 'FAIL'` implies the observed signature equals the issue's signature under the issue's
  own `ruleset_version` (R-02) — a different failure is a `separate_defect_finding`, never a `FAIL`.
- No `rung_attempt` row exists for a rung with `rung_order` greater than the reproducing rung
  (SC-002).
- Every `skipped` rung carries a `skip_reason`; `skipped` and `error` are never counted as
  `not_reproduced`.
- A timeout, a build failure, an unparseable report and an absent report never produce `PASS`
  (SC-006).
- Every `execution_run` has `credential_scan_pre = 'clean'`; a `hit` aborts before the checkout is
  readable (SC-004).
- Every `execution_run` records an `egress_posture` stating the run container had an empty route table
  and no resolver; no `egress_denial` row has `phase = 'run'` (SC-003, R-19).
- `reproduction_attempt.observed_runs` and `reproduced_runs` equal the `rung_attempt` row for
  `reproducing_rung`, and are never a sum over rungs (R-18).
- Every `execution_run` has `workspace_destroyed_at` within the grace period of `finished_at`,
  including `killed` and `failed` runs (SC-005).
- No `reproduction_fixture` row has fixture contents, in any column, in any mode (C-04, SC-010).
- `construction_mode = 'anonymised'` implies a non-null `grant_ref` and a null `recipe`.
- No query aggregates `test_result` rows across `execution_run_id` values (FR-013).
- No worker job is in a running state while a `ci_delegation` is `requested` or `running`
  (SC-011, 012 FR-025).
- Every read is constrained by `tenant_id` from the authenticated context; a foreign execution,
  workspace, cache or fixture returns not-found (SC-012).
