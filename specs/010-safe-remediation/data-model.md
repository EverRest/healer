# Data Model: reversible production actions

Schema `remediation`. Tables this feature owns; `Issue`, `Evidence`, `EvidenceLink` and
`AuditEntry` belong to 001, `PolicyDecision`, `AutonomyGrant` and `ApprovalRequest` to 002,
`Component` and `DeploymentUnit` to 004, and `workflow_run`, `workflow_callback` and `agent_run` to
012 — all referenced here, none redefined.

Identifiers are UUID v7; timestamps `timestamptz` UTC. Every table carries `tenant_id` with an
index `(tenant_id, …)` ([prisma rules](../../.claude/rules/prisma-migrations.md)).

## remediation_catalogue_version (append-only)

The catalogue is code (R-01); this table records which code.

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| digest | text | content hash over every action definition; unique |
| action_keys | text[] | the closed set in this version |
| build_ref | text | the build that published it |
| undo_attestations | jsonb | per action key: test run identifier, result, executed_at (R-02). **The sole source of 002's `hasTestedUndo`** (C-18) |
| published_at | timestamptz | |

Not tenant-scoped — the catalogue is the product, not a tenant's configuration. Never updated; a
changed definition is a new row. An action whose `undo_attestations` entry does not match the
running build is not loadable (FR-003).

`action_keys` includes the undo-only key `deployment.restore_dispatch_version` (C-15, R-19). It is
loadable, dispatchable with `mode: "undo"`, and **not proposable**: no proposal path accepts it and no
eligibility entry is written for it.

`undo_attestations` is published on `RemediationCataloguePublished`
([contracts/events.md](contracts/events.md)) and is what 002 reads as `hasTestedUndo`
(002 `contracts/evaluation.md`). Under C-18 `ACTION_CEILING` is `f(actionClass, hasTestedUndo)` and
`reversible_remediation` has **no autonomy level** when the undo is unattested, so a release that
drops an attestation lowers the ceiling rather than leaving a stale permission standing. Nothing else
in this schema asserts reversibility.

## remediation_target

The resource an action applies to. Resolved from the architecture graph, never from a name.

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| component_id | uuid | `Component` (004) |
| deployment_unit_id | uuid? | `DeploymentUnit` (004) — distinct from component (VII) |
| environment | text | |
| kind | enum | `deployment` · `workload` · `feature_flag` · `queue` · `job` |
| platform_ref | text | adapter-scoped identifier |
| revision_ref | text? | last observed platform revision counter (R-13) |
| revision_observed_at | timestamptz? | |
| min_healthy_replicas | int? | required for `workload.restart` (R-17) |
| min_replicas, max_replicas | int? | required for `service.scale` (R-17) |
| remediable_flag_keys | text[]? | required for `feature_flag.disable`; an allowlist, never "all flags" (R-17) |
| holding_destination | text? | required for `queue.drain`; must be probed writable at precondition time (R-17) |
| idempotency_declared | bool? | required for `job.retry`; tenant-asserted, null is not false (R-17) |

Unique `(tenant_id, kind, platform_ref, environment)`. Dispatch resolves a target by id **within the
tenant**, so a foreign target is unaddressable rather than filtered (FR-024).

The five declaration columns are nullable on purpose: **null means undeclared, not zero and not
false.** Eligibility for an action is the **conjunction** of a stored opt-in row in
`remediation_target_eligibility` *and* the presence of every declaration that action requires
(FR-015, R-17). Neither half alone makes an action available: the opt-in without the declaration is a
tenant agreeing to something whose bound is unknown, and the declaration without the opt-in is a bound
nobody agreed to apply.

## remediation_target_eligibility

Opt-in, per target and per action type (FR-015, R-12).

`id`, `tenant_id`, `target_id`, `action_key`, `granted_by`, `granted_at`, `revoked_at?`, `note`.
Unique `(tenant_id, target_id, action_key)`. Absence is refusal; there is no default-eligible flag.
A row is necessary but **not sufficient**: the action is available only when the target also carries
every declaration that action requires (FR-015, R-17).

## remediation_action_bound

Per-tenant, per-action numeric bounds **this feature owns**. Values are placeholders until stage-0 and
the pilot supply grounds for them; the *existence* of each bound is not configurable.

`tenant_id`, `action_key`, `blast_radius` jsonb (bound per the action's declared dimension),
`verification_window_seconds`, `updated_at`. PK `(tenant_id, action_key)`.

**`remediation_limit` is deleted (C-11).** Rate limits, cooldowns, attempt caps and the recurrence
window are **002's**, stored and evaluated there, scoped by the `targetRef` and `fingerprint` this
feature supplies on `DecisionInput` (002 `contracts/evaluation.md`). This schema keeps no copy of
them and no second enforcement point: Principle IV puts every limit in the deterministic engine that
already writes a trace and a reason code, and two stores with two keys will disagree with neither
being authoritative. What remains here is the **projection**: the refusal reason codes
`RATE_LIMITED`, `COOLDOWN` and `ATTEMPT_CAP` recorded on `remediation_attempt.refusal_reason` when
002's decision carries the corresponding reason code, so a tenant reading an attempt still learns why
nothing happened (002 FR-015).

Blast radius and the verification window stay here because they are the action's own declarations, not
limits on how often it may run: a blast-radius bound is evaluated against the resolved target and the
architecture graph (R-12), and a verification window is part of the anchor definition (R-03).

## remediation_attempt

One proposal and everything that happened to it.

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | 001 |
| issue_fingerprint | text | copied at proposal; the recurrence counting key (R-08) |
| target_id | uuid | |
| action_key | text | must be in the loaded catalogue version |
| catalogue_version_id | uuid | which definitions produced this attempt |
| parameters | jsonb | schema-validated against the action's parameter schema |
| mode | enum | `dry_run` · `execute` |
| policy_decision_id | uuid? | 002; **null only for `dry_run`** |
| approval_request_id | uuid? | 002, when `REQUIRE_APPROVAL` |
| state | enum | see transitions |
| invocation_id | uuid | idempotency key carried to the runner (FR-010) |
| workflow_run_id | uuid | 012 |
| prior_state | jsonb | observed before the mutation, bounded and structured (R-05) |
| undo_directive | jsonb | fully resolved at dispatch, literal parameters (R-05) |
| blast_radius | jsonb | computed and bounded at proposal (R-12) |
| revision_ref_at_dispatch | text? | (R-13) |
| refusal_reason | text? | which precondition, eligibility gap, block or policy reason code refused it; `RATE_LIMITED` · `COOLDOWN` · `ATTEMPT_CAP` are projections of 002's decision, not evaluated here (C-11) |
| mitigation | bool | true once verified; never resolves a code problem (R-11) |
| proposed_at, dispatched_at?, result_at?, verified_at? | timestamptz | |
| time_to_verified_remediation_ms | bigint? | issue creation → `improved` (R-15, D-19a) |

Unique partial index `(tenant_id, target_id) where state in ('dispatched','awaiting_verification')`
— this is FR-012 (R-07). Unique `(invocation_id)`. Index
`(tenant_id, target_id, issue_fingerprint, proposed_at)` for the recurrence query.

`RemediationHistory` is that index read as a query. There is no history table (VIII).

## verification_window

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| attempt_id | uuid | unique |
| anchor_kind | enum | `production_metric` · `pre_existing_healthcheck` · `pre_existing_test` — **no member names the action's own output** (R-03) |
| anchor_ref | text | selector resolved by an observability adapter (003) |
| baseline_window | tstzrange | must close before `issue.first_seen_at`; enforced at catalogue load and re-checked at dispatch |
| baseline_value | numeric | |
| expected_direction | enum | `decrease` · `increase` · `return_to_baseline` |
| expected_magnitude | numeric | |
| opens_at, deadline_at | timestamptz | |
| outcome | enum? | `improved` · `not_improved` · `inconclusive` |
| closed_at | timestamptz? | |

Each tick's sample is an `Evidence` record of type `metric_delta` or `test_result` emitted by the
verification step (001 FR-007, FR-008) and linked with `conclusion_type = 'remediation'`. There is
no private observation log (VIII, R-06).

## undo_record

`id`, `tenant_id`, `attempt_id` (unique), `undo_action_key` text, `trigger` (`not_improved` ·
`inconclusive` · `external_change` · `human`), `directive` jsonb (copied from the attempt, not
recomputed), `state_before` jsonb, `state_after` jsonb, `observed` bool (false when the state could
not be read), `result` (`restored` · `failed`), `failure_reason?`, `dispatched_at`, `result_at?`.

`undo_action_key` is the catalogue key the undo dispatches, which is **not always the forward action's
key**: `deployment.rollback`'s undo is `deployment.restore_dispatch_version`, whose single parameter
must equal the attempt's `revision_ref_at_dispatch` (C-15, R-19).

`observed = false` is why the escalation says "state unreadable" instead of reporting intent (R-09).

## target_block

`id`, `tenant_id`, `target_id`, `reason` (`undo_failed` · `external_change_unresolved` · `human`),
`attempt_id?`, `evidence_ids` uuid[], `opened_at`, `cleared_by?`, `cleared_at?`, `clear_note?`.

Partial unique index `(tenant_id, target_id) where cleared_at is null`. While a block is open,
**every** action against that target is refused at proposal, not only the one that failed (R-09).

## State transitions

```text
attempt:  proposed ──policy DENY──▶ refused
          proposed ──precondition / limit / eligibility / block fails──▶ refused
          proposed ──REQUIRE_APPROVAL──▶ awaiting_approval ──expiry──▶ refused (002 FR-016)
          proposed | awaiting_approval ──ALLOW──▶ dispatched
          dispatched ──runner result ok──▶ awaiting_verification
          dispatched ──runner result failed──▶ failed  (undo dispatched if prior state changed)
          awaiting_verification ──improved──▶ verified   (mitigation; resolution only via 001)
          awaiting_verification ──not_improved | inconclusive──▶ undoing
          awaiting_verification ──external revision change──▶ invalidated ──▶ escalated (R-13)
          undoing ──restored──▶ undone (issue reopened)
          undoing ──failed──▶ undo_failed ──▶ target_block opened, escalated, terminal (R-09)

dry_run:  proposed ──▶ planned | refused     (never leaves the plan() capability, R-10)
```

## Invariants

- No attempt with `mode = 'execute'` exists without a `policy_decision_id` (FR-008, SC-002).
- `dispatched_at is not null` implies `prior_state` and `undo_directive` are both present (R-05).
- At most one attempt per target is in `dispatched` or `awaiting_verification` (R-07).
- `verification_window.baseline_window` upper bound precedes the issue's `first_seen_at` (R-03).
- An attempt whose target has an open `target_block` cannot leave `proposed` (R-09).
- A `verified` attempt sets `mitigation = true` and never transitions an issue classified as a code
  problem to `resolved` (R-11, FR-017).
- Every attempt, result, verification outcome and undo has an `audit_entry` (001 FR-012) and at
  least one `evidence_link` for the claim that the action was justified and that it worked
  (001 FR-009).
- An action is available for a target only when both a `remediation_target_eligibility` row exists and
  every declaration that action requires is non-null on the target (FR-015, R-17).
- No `undo_record` for a `deployment.rollback` attempt exists whose `directive` parameter differs from
  that attempt's `revision_ref_at_dispatch`; the undo names exactly one deployment (C-15, R-19).
- No `remediation_target_eligibility` row exists for `deployment.restore_dispatch_version`, and no
  attempt with that action key exists in `mode` other than `undo` (C-15).
- No rate limit, cooldown, attempt cap or recurrence window is stored in this schema; a
  `refusal_reason` of `RATE_LIMITED`, `COOLDOWN` or `ATTEMPT_CAP` always resolves to a 002 decision
  carrying that reason code (C-11).
- Every read and every dispatch is constrained by `tenant_id` from the authenticated context; a
  foreign target or attempt returns not-found (FR-024).
