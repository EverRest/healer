# Data Model: context resolution across the hybrid boundary

Schema `context` in the control plane. Identifiers are UUID v7; timestamps `timestamptz` UTC. Every
table carries `tenant_id` with an index `(tenant_id, …)`
([prisma rules](../../.claude/rules/prisma-migrations.md)).

One table lives **in the execution plane** and is listed separately at the end; it is the only state
this feature keeps outside the control plane, and keeping it outside is the point.

Tables owned elsewhere and only referenced here: `issue`, `evidence`, `evidence_link`,
`audit_entry`, `normalisation_ruleset` (001); `workflow_run`, `workflow_callback`,
`runner_registration`, `runner_capability_resolution` (012); `component` (004);
`policy_decision`, budget state (002).

## context.context_snapshot (append-only)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | 001 |
| version | int | 1 for the first collection; a re-collection is `version + 1` (FR-022) |
| predecessor_id | uuid? | the snapshot this one supersedes; earlier versions stay readable |
| collected_at | timestamptz | runner clock |
| window_from, window_to | timestamptz | the resolved collection window, by observed time |
| plan_digest | text | content hash of the requested plan — identical issues match (R-04, R-05) |
| collection_ruleset_version | int | which planning rules (FR-001) |
| ranking_ruleset_version | int | which weights produced the ordering (FR-019) |
| redaction_ruleset_version | int | applied in the execution plane (FR-008) |
| normalisation_ruleset_version | int | 001's, reused for deduplication (R-10) |
| contract_version | int | the boundary schema validated on both sides (012 FR-022) |
| runner_id | uuid | 012 `runner_registration` |
| runner_image_version | text | recorded, because a degraded collection must be explicable |
| completeness | jsonb | see below — the machine-readable descriptor of FR-017 |
| inclusion_cut_score | int? | the score at which the context budget bound (FR-020) |
| budget_state | enum | `within` · `degraded` · `budget_limited` (002 FR-011, R-15) |
| finalised_at | timestamptz | set once; a finalised snapshot is immutable |

Unique `(tenant_id, issue_id, version)`. Index `(tenant_id, issue_id, version desc)`.

`completeness` carries: `expected` (collector keys in the requested plan), `contributed`,
`missing`, `partial`, `degraded_precision` (component attribution fell back to the default scope),
and `contradictions` — pairs of item identifiers and the field on which they disagree (R-14).

## context.collection_pass (append-only)

One dispatch to the runner. The initial pass is ordinal 0; every follow-up (FR-005) is its own row.

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| snapshot_id | uuid | |
| pass_ordinal | int | unique `(snapshot_id, pass_ordinal)` |
| plan_digest | text | idempotency key with `(issue_id, pass_ordinal)` (R-05) |
| requested_plan | jsonb | the deterministic plan — collectors, window, filters |
| resolved_plan | jsonb | requested ∩ runner capabilities (R-04) |
| requested_by_step | text | `system` for ordinal 0; the requesting step for a follow-up |
| request_reason | text? | enumerated reason for a follow-up pass |
| workflow_run_id | uuid | 012 — the persisted wait (FR-025) |
| callback_id | uuid | 012 `workflow_callback`, kind `runner_result` |
| dispatched_at | timestamptz | |
| completed_at | timestamptz? | set by the result batch or by the deadline tick |
| outcome | enum | `completed` · `partial` · `deadline_expired` · `runner_unavailable` |

The follow-up cap of FR-005 is `max(pass_ordinal) < configured limit`, checked at request time.

## context.source_outcome (append-only)

One row per collector per pass — the machine-readable answer to "what did we not get" (FR-014).

`id`, `tenant_id`, `pass_id`, `collector_key`, `status` (`collected` · `partial` · `unavailable` ·
`timed_out` · `withheld` · `not_attempted`), `reason_code`, `item_count`, `truncated` bool,
`duration_ms`, `gap_evidence_id?`.

`gap_evidence_id` is null only when `status = collected`. Every other status has exactly one
`collection_gap` evidence record, which is what makes an absence citable (R-07, 001 FR-009).

Closed reason codes: `source_unreachable` · `auth_revoked` · `timeout` · `retention_exceeded` ·
`capability_unavailable` · `budget_exhausted` · `redaction_withheld` · `schema_rejected` ·
`empty_result`.

## context.context_item

The ranking and inclusion view over an evidence record. **It does not duplicate the fact** — the
excerpt, source system, source reference and observed time live on `evidence` (001).

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| snapshot_id | uuid | |
| pass_id | uuid | which pass produced it |
| evidence_id | uuid | 001 — the item *is* an evidence record (FR-012) |
| item_class | enum | the boundary shape it arrived as (R-03) |
| collector_key | text | |
| dedup_key | text | `(item_class, normalised_signature, component, environment)` (R-10) |
| occurrence_count | bigint | collapsed duplicates (FR-018) |
| first_observed_at, last_observed_at | timestamptz | across the collapsed set |
| component_id | uuid? | 004; null with `component_attribution = fallback` recorded |
| component_attribution | enum | `resolved` · `fallback` · `unknown` |
| relevance_score | int | integer sum of term contributions (R-09) |
| ranking_terms | jsonb | `[{ term, weight, contribution }]` — the reason, not just the number |
| inclusion_state | enum | `included` · `excluded` — excluded items are retained (FR-020) |
| redaction_dominated | bool | excerpt survived but carries no signal (R-08) |

Unique `(snapshot_id, dedup_key)`. Index `(snapshot_id, inclusion_state, relevance_score desc,
last_observed_at asc, evidence_id asc)` — the index is the total order, so ordering is stable by
construction (R-09).

## context.collection_ruleset (immutable)

`version` (PK), `rules` jsonb, `published_at`, `note`. Maps issue kind, component, environment and
first-seen time to collectors, window and filters. Never edited; a change is a new version. A
snapshot's plan is recomputable from the version it recorded (FR-004).

## context.ranking_ruleset (immutable)

`version` (PK), `terms` jsonb (`[{ term, weight }]`, integer weights), `published_at`, `note`.

## context.redaction_ruleset (immutable)

`version` (PK), `detectors` jsonb, `published_at`, `note`, `runner_min_image_version`.

Published here and distributed to runners; applied **only** in the execution plane (FR-008). The
control plane stores the definition so a snapshot's redaction is explicable, never the detections.

## context.collector_registration

`collector_key` (PK), `item_classes` text[], `parameter_schema` jsonb, `default_timeout_ms`,
`required_capability`, `plane` (always `execution`), `introduced_at`.

The closed set a follow-up request may name (FR-005, R-12). Global, not tenant-scoped: which
collectors exist is a product fact; which are configured is tenant configuration held in the runner.

## context.boundary_rejection (append-only)

`id`, `tenant_id`, `runner_id`, `pass_id?`, `contract_version`, `schema_error_paths` text[],
`payload_digest` text, `byte_size` int, `received_at`.

**No payload content is stored** (R-13). Counts are visible to the tenant and to Healer
(FR-010, 012 FR-022).

## Execution plane only — `withholding_ledger`

Lives inside the runner, in the customer's network, on their storage and their retention. Never
replicated to the control plane.

`local_ref` (uuid, PK), `collector_key`, `item_class`, `reason_code`, `source_locator`,
`raw_reference`, `observed_at`, `expires_at`.

What crosses is `{ localRef, itemClass, reasonCode, collectorKey, observedAt }` inside a
`collection_gap`. The control plane holds a reference it is structurally unable to dereference; a
human inside the customer's plane resolves it locally (FR-009, R-08).

## State transitions

```text
collection_pass:  dispatched ──result batch──▶ completed | partial
                  dispatched ──deadline tick, no batch──▶ deadline_expired
                             (every planned source → not_attempted + gap record)
                  dispatched ──runner not registered / refused──▶ runner_unavailable
                             (issue shows context pending, never empty — FR-025)

context_snapshot: collecting ──all passes settled──▶ finalised (immutable; FR-022)
                  finalised  ──re-collection──▶ new snapshot version n+1, predecessor linked
                  collecting ──budget exhausted──▶ finalised, budget_limited (R-15)

context_item:     ranked ──above the cut──▶ included
                  ranked ──below the cut──▶ excluded (retained, never dropped — FR-020)

source_outcome:   attempted ──runner reports──▶ collected | partial | unavailable | timed_out
                                              | withheld
                  planned   ──never attempted──▶ not_attempted
                  (every status but `collected` writes exactly one collection_gap evidence record)

evidence:         (owned by 001) linked ──source unavailable──▶ detached ──expires_at──▶ purged
```

## Invariants

- Every `context_item` resolves to an `evidence` record whose `produced_by_step` is the collection
  step that emitted it (FR-012, 001 FR-008). No item carries a fact the evidence record does not.
- Every `source_outcome` with `status <> 'collected'` has exactly one `collection_gap` evidence
  record, and every `collection_gap` in the snapshot has exactly one `source_outcome` (R-07).
- A snapshot exists whenever at least one source was attempted, including when none succeeded
  (FR-015, SC-004).
- `finalised_at` is set once. No row in a finalised snapshot is updated; a re-collection creates
  version n+1 and leaves the predecessor readable (FR-022).
- The requested plan recomputes byte-identically from `(issue facts, collection_ruleset_version)`,
  and the recomputation hashes to the stored `plan_digest` (FR-004, SC-007).
- Item ordering recomputes identically from `(relevance_score, last_observed_at, evidence_id)`; no
  ordering depends on database return order (FR-019, SC-007).
- Every item's `dedup_key` uses the `normalisation_ruleset` version the snapshot recorded — there is
  no second normaliser in this feature (FR-018, R-10).
- Items below the inclusion cut exist with `inclusion_state = 'excluded'`; no item is deleted for
  budget reasons (FR-020).
- No transmitted payload contains a raw log body, request or response payload, configuration value
  or secret. Enforced by the boundary schema at egress and independently at ingress, and measured by
  the seeded-marker corpus (FR-007, SC-001, SC-002).
- No `boundary_rejection` row contains payload content (R-13).
- No withheld item's reference is resolvable from the control plane (FR-009, R-08).
- No collected excerpt reaches a planning input, a ranking term, a policy predicate (002 FR-003) or
  a tool argument. Enforced by the branded type at compile time and measured by the differential
  corpus (FR-021, SC-010).
- No control-plane credential exists for any customer observability, repository, configuration or
  deployment system (FR-002).
- Every snapshot, pass, item, source outcome and rejection carries `tenant_id` from the
  authenticated context; a foreign identifier returns not-found, never forbidden (FR-023, SC-009).
- A collection pass in flight has either a pending `workflow_callback` or a `deadline_at` on its
  run — the stuck-run invariant of 012, which is what keeps FR-025 from producing a run that waits
  forever.

## Implementation notes (phases 1–3)

Built as `prisma/migrations/20261004000000_context_core` (schema `context` in `schema.prisma`).

- **Enums mirror the boundary lists.** `collector_key`, `item_class`, `source_status`,
  `gap_reason_code` and `follow_up_reason` are mirrors of the closed lists in
  `packages/boundary-contract/src/collection.ts`, the one authority; `enum-sync.test.ts` fails if
  either side drifts. `budget_state` is `context_budget_state`; `component_attribution`,
  `inclusion_state` and `pass_outcome` are as listed above. `request_reason` is the
  `follow_up_reason` enum, not free text.
- **Global tables.** `collector_registration` and the three ruleset tables carry no `tenant_id`
  (product facts, not tenant configuration); `collector_registration.plane` has a CHECK
  `= 'execution'`, synced from `COLLECTOR_REGISTRY` by `syncCollectorRegistry`.
- **Append-only.** Triggers on the seven tables listed for T004 (UPDATE/DELETE and TRUNCATE).
  `finalised_at`, `completed_at` and `outcome` are therefore insert-time columns for now — see
  QUESTIONS.md "003 phases 1–3 — append-only vs. lifecycle columns".
- **Foreign keys.** `(issue_id, tenant_id)` → `issue`, `(snapshot_id, tenant_id)`,
  `(pass_id, tenant_id)`, `(workflow_run_id, tenant_id)` → `workflow_run` and
  `(evidence_id, tenant_id)` → `evidence` are composite, so a row naming another tenant's record is
  unrepresentable. Not FKs: `predecessor_id`, `gap_evidence_id`, `component_id` (optional
  composites), `callback_id`, and `boundary_rejection.runner_id` / `pass_id` (a rejection of an
  unknown runner or pass must still be recorded).
- **`source_outcome`** has a CHECK: `gap_evidence_id IS NULL` exactly when `status = 'collected'`.
- **`boundary_rejection`** holds only the columns listed above; `check:no-payload-at-rest` fails if
  any other column appears, a digest is not sha256 hex, or a path is not structural text
  (`/^[A-Za-z0-9_.<>$#-]{1,200}$/`). Unparseable JSON is recorded with the path `$#invalid_json`.
- No `withholding_ledger` exists in the control-plane schema (a test asserts the word's absence).

