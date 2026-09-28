# Data Model: issue lifecycle and evidence substrate

Schemas `issue`, `evidence`, `audit`. Identifiers are UUID v7; timestamps `timestamptz` UTC.
Every table carries `tenant_id` with an index `(tenant_id, …)`.

## issue.issue

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| kind | enum | `production_incident` · `user_report` · `monitoring_alert` · `regression` · `automated_detection` · `knowledge_drift` (FR-001) |
| component_id | uuid? | `Component` in 004 — never a service name |
| environment | text | |
| severity | enum | `critical` · `high` · `medium` · `low` |
| state | enum | see transitions |
| fingerprint | text | |
| ruleset_version | int | which normalisation produced the fingerprint (R-01); FK `normalisation_ruleset.version` — a version that was never published cannot be recorded |
| occurrence_count | bigint | |
| first_seen_at, last_seen_at | timestamptz | source clock (R-10) |
| stale_at | timestamptz? | set by the staleness job (R-11) |
| resolved_at | timestamptz? | set when `state` moves to `resolved`, cleared on reopen — what FR-005's reopen window is measured against (001 T022) |
| created_at | timestamptz | |

Issue-to-issue links live in `issue_relationship`, not in columns here — see below.

Indexes: `(tenant_id, fingerprint) where state not in ('merged', 'removed')` — a fingerprint lookup
during ingestion must still find a `resolved` issue (FR-005's reopen window) and a `stale` one
(R-11: surfaced, not closed); only `merged` and `removed` issues are no longer the fingerprint's
canonical row. (There is no `closed` state — the state set is exactly the nine below; an earlier
draft of this line referenced one that was never defined, corrected here.) Also
`(tenant_id, state, last_seen_at)`, `(tenant_id, component_id, last_seen_at)`.

`knowledge_drift` issues terminate at human adjudication and never enter reproduction or change
(FR-001a).

## issue.issue_relationship

The single store for every issue-to-issue link (FR-020). A relationship is a row, not a column, so
`related` can be many while `recurrence_of` and `merged_into` stay at most one.

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | the subject |
| other_issue_id | uuid | FK issue; `<> issue_id` |
| kind | enum | `related` · `recurrence_of` · `merged_into` |
| rule | text | which deterministic correlation rule produced it, or `human` |
| created_at | timestamptz | |
| removed_at | timestamptz? | set when a merge is undone or a correlation is withdrawn (R-08) |

Unique `(tenant_id, issue_id, other_issue_id, kind) where removed_at is null`, plus one partial
unique index per single-valued kind — `(tenant_id, issue_id) where kind = 'recurrence_of' and
removed_at is null` and the same for `merged_into` — so an issue is a recurrence of at most one issue
and merged into at most one issue, while still being able to be both. Index
`(tenant_id, other_issue_id, kind)`.

`related` is **deterministic**: a rule over component, environment and time window (FR-020), named in
`rule` so a link can be explained and recomputed. No model proposes a relationship, and `related`
never merges the two issues or affects either one's state.

`merged_into` carries the state: an issue with a live `merged_into` row is in state `merged`, and
removing the row is the unmerge (R-08). The two are written in one transaction by one method
(`IssueMergeRepository.merge`; `transition` refuses `merged`) and the database refuses to commit a
disagreement — a deferred constraint trigger enforces *state = `merged` ⇒ a live row* and *a live row
⇒ state `merged` or `removed`* (001 T049, migration `20260928120000`). `other_issue_id <> issue_id`
is a `CHECK`. A merge is `rule = human`, and merges form a forest of depth one: a merged issue is
never a target and a target is never merged. Unmerge sets `removed_at` and keeps the row as history;
a later merge writes a new row. **A merge moves nothing** — no evidence row, no `occurrence_count`,
no timestamp — which is why an unmerge has nothing to restore on either side (R-08).

## issue.issue_event (append-only)

`id`, `tenant_id`, `issue_id`, `type` (`signal_received` · `state_changed` · `merged` · `unmerged` ·
`related` · `action_taken` · `note`), `from_state?`, `to_state?`, `cause` (`ingestion` · `agent` ·
`human` · `policy` · `system`), `actor_ref`, `payload` jsonb (bounded, no free-form customer text),
`observed_at`, `received_at`.

A `merged` event carries `from_state` (the state the issue left — what the unmerge restores; the
event is append-only, so it cannot be lost) and `payload {intoIssueId, relationshipId, reason}`,
where `relationshipId` ties it to the `merged_into` row it created; `unmerged` carries
`payload {intoIssueId, relationshipId}`. Each is written on the merged issue only (001 T049/T050).

**This table holds domain facts; 012's `workflow_transition` holds machine steps** (C-14). A signal
arriving is not a workflow transition, and a job retry is not a domain fact — the grains differ, so
neither table is total on its own. The timeline is a **union query** over both, plus `evidence`,
ordered by `observed_at` (R-07, FR-013). Nothing is copied between the two: the boundary is the test
that keeps them from becoming two stores of one fact.

## issue.ingestion_delivery

`provider`, `delivery_id`, `tenant_id`, `received_at`, `signal_count`, `outcome`
(`accepted` · `duplicate` · `partial` · `failed`). The idempotency key (R-09) is unique
`(tenant_id, provider, delivery_id)` — tenant-scoped, since a provider's delivery id is not
guaranteed globally unique across tenants.

## issue.normalisation_ruleset

`version` (PK), `rules` jsonb, `published_at`, `note`. Never edited; a change is a new version —
enforced the same way as `evidence`/`audit_entry` (R-03): a database trigger rejecting `UPDATE`,
`DELETE` and `TRUNCATE`, not application discipline. Not tenant-scoped: one ruleset governs
fingerprinting for every tenant. Recomputing a historical fingerprint uses the version the issue
recorded — `issue.ruleset_version` is a foreign key into this table (001 T011), so a fingerprint
can never name a version that does not exist.

## evidence.evidence (append-only)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | |
| type | enum | `error_signature` · `trace_shape` · `metric_delta` · `deploy_ref` · `commit_ref` · `test_result` · `file_path` · `tool_output_summary` · `document_excerpt` · `collection_gap` · `budget_degradation` (002 FR-012) · `graph_fact` (004) |
| source_system | text | e.g. `loki`, `gitlab`, `sandbox` |
| source_ref | text | identifier or URL in that system |
| source_label | text | human-readable, survives detachment — "from logs, March" (R-04) |
| excerpt | text? | bounded at capture; `excerpt_truncated` when clipped (R-05) |
| excerpt_truncated | bool | |
| payload | jsonb | structured fields for the type; schema-validated, no free-form strings |
| produced_by_step | text | which step observed this (R-06) |
| ref_state | enum | `linked` · `detached` |
| observed_at, received_at | timestamptz | (R-10) |
| expires_at | timestamptz | retention; shorter than issue retention |

All four of 004's discovery shapes crossing the boundary — `component_candidate`,
`deployment_unit_candidate`, `dependency_observation`, `repository_ref` (012
`contracts/runner-protocol.md`) — are persisted as evidence of type **`graph_fact`**, with the shape
name and its fields in `payload`. The transport shapes are plural because the contract is closed per
fact family; the evidence type is one because "what we observed about the architecture" is one kind of
observation. This mapping is 001's call (FR-007a).

`UPDATE` and `DELETE` are rejected by rule, except `ref_state` transitioning `linked → detached`
and the privileged retention path (R-03).

Index `(tenant_id, issue_id, observed_at)`, `(tenant_id, expires_at)`. The second is not partial on
`ref_state`: retention (T052) lists expired evidence nothing cites whatever its `ref_state`, and
expired-and-cited evidence still `linked`, so a `where ref_state = 'linked'` index could not serve the
first branch.

## evidence.evidence_link (append-only)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| evidence_id | uuid | |
| conclusion_type | enum | `classification` (006) · `diagnosis` · `hypothesis` · `impact` · `verification` · `support_answer` · `remediation` |
| conclusion_id | uuid | row in the owning feature |
| relation | enum | `supports` · `contradicts` · `contextualises` |
| asserted_by_step | text | **must equal the executing step; a mismatch is rejected** (R-06) |
| asserted_at | timestamptz | |

Unique `(evidence_id, conclusion_id, relation)`. No API exists to create a link for a step other
than the caller, and none exists to create links retrospectively.

## audit.audit_entry (append-only)

`id`, `tenant_id`, `actor_type` (`agent` · `human` · `system` · `runner`), `actor_ref`, `action`,
`target_type`, `target_id`, `reason`, `evidence_ids` uuid[], `agent_run_id?` (012), `policy_decision_id?`
(002), `outcome`, `occurred_at`.

`action` is **a registered `policy_action.action_key`** (002), never free text. That is what gives
002's `check:policy-coverage` a join key and `policy_action.mutating` as its filter: a reconciliation
of executed mutating actions against decisions cannot be written over a free-text column.

**This table and 012's `agent_run` both stand** (C-13). They have different key sets: `audit_entry` is
the index over **every** actor — human, system, runner, agent — while `agent_run` is one agent
invocation. The model, prompt version, token, cost and tool fields FR-012 requires are **not repeated
here**: they resolve through `agent_run_id`, which is why 012 FR-033 forbids a second store of the
agent-run facts rather than a second table. An entry whose `actor_type` is not `agent` has no
`agent_run_id` and no model fields to resolve, which is exactly why one table could not serve both.

## audit.deletion_tombstone

`id`, `tenant_id`, `target_type`, `target_id`, `requested_by`, `deleted_at`, `reason`. Content is
not retained — only the fact that a deletion happened (R-12). Identifiers, a time and the requester's
own stated `reason` (1–500 characters) and `requested_by` (1–128, a caller-asserted actor string): no
column exists that deleted content could be put in.

Unique `(tenant_id, target_type, target_id)` — one tombstone per deleted target. **Immutable**: a
trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` and, unlike the four append-only tables, does *not*
honour the `healer.privileged_write` bypass, because the deletion path that writes a tombstone turns
that bypass on (migration `20260929000000`).

Deleting an issue (T053) removes, in one transaction: the `issue` row; its `issue_event`, `evidence`
and `evidence_link` rows; `issue_relationship` rows in both directions; its `workflow_run`,
`workflow_transition` and `workflow_callback` rows; `audit_entry` rows whose `target_id` is the issue
or one of its evidence records; and the outbox rows about it. `agent_run` rows stay (the tenant's spend)
with `issue_id` set to null. It is refused (nothing changed) while other issues are still merged into
it, while it is itself `merged` into another issue, and while an outbox drain worker holds a claim on
one of its events. What it does and does not touch of other issues:

- Never touched: their own rows — events (including ones whose payload names the deleted id, which
  the tombstone resolves), evidence, relationships to third issues, audit entries (including an entry
  about them that cites the deleted issue's evidence ids).
- Touched, because nothing can tell them apart: **every `evidence_link` naming one of the deleted
  issue's evidence records, whoever's conclusion made it**. A link carries a `conclusion_id` and no issue,
  and the conclusion tables (006 and later) do not exist yet. The one situation in which another issue
  can legitimately cite this issue's evidence in v1 is a merge, which is why a `merged` issue is
  refused ("unmerge it first"); a citation from a conclusion the deletion cannot attribute is lost
  (QUESTIONS.md "001 T053").

`IssueDeleted` (tombstone id only) is written to the outbox in the same transaction.

## State transitions

```text
issue:  detected ──context collected──▶ investigating
        investigating ──diagnosis──▶ diagnosed
        diagnosed ──action taken──▶ acting ──verified──▶ resolved
        diagnosed | acting ──no path──▶ needs_human
        any non-terminal ──human closes it──▶ resolved (self_resolved; no verification evidence)
        any non-terminal ──no signal, no progress──▶ stale (surfaced, not closed)
        resolved ──matching signal inside reopen window──▶ investigating
        resolved ──matching signal outside window──▶ new issue, recurrence_of
        any ──merge──▶ merged (a live merged_into relationship; reversible)
        merged ──unmerge──▶ the state the merge left (recorded on the merge event)
        any ──tenant deletion──▶ row deleted + tombstone (not `removed`: that row would keep the
                                 fingerprint and component — `removed` stays a state nothing enters
                                 by deletion; see QUESTIONS.md "001 T053")

evidence: linked ──expires_at, or source unavailable──▶ detached   (a conclusion cites it: the row,
                                                                    its excerpt and label stay)
          any state ──expires_at, and no evidence_link names it──▶ purged   (deleted; audited)
```

`detached` is a terminal state for evidence a conclusion cites: purging it would leave that
conclusion with no support (FR-009, R-04), and `evidence_link` is append-only with a `Restrict`
foreign key. Whether such a record should also lose its excerpt at expiry is open — see
QUESTIONS.md "001 T052".

## Invariants

- No row in `evidence`, `evidence_link`, `issue_event` or `audit_entry` is ever updated, except
  `evidence.ref_state` moving to `detached`.
- Every persisted conclusion has ≥ 1 `evidence_link`. Enforced by `gate-evidence` (012) and by a
  continuous check (SC-002).
- `evidence_link.asserted_by_step` equals the step that executed the write.
- Every read is constrained by `tenant_id` from the authenticated context; a foreign identifier
  returns not-found.
- An issue in a non-terminal state has either a pending workflow callback or a deadline (012).
- `occurrence_count` never decreases; an unmerge restores counts to both sides rather than splitting.
- Every `audit_entry.action` resolves to a registered `policy_action.action_key` (002); the model,
  prompt version, token and cost fields of FR-012 resolve through `agent_run_id` and are not
  duplicated here (C-13).
- An issue has at most one live `recurrence_of` and at most one live `merged_into` relationship; a
  `related` relationship changes neither issue's state and names the deterministic rule that produced
  it (FR-020).
