# Data Model: system model and architecture discovery

Schema `architecture`. Identifiers are UUID v7; timestamps `timestamptz` UTC. Every table carries
`tenant_id` with an index leading on it (012 FR-048).

`issue`, `evidence`, `evidence_link` and `audit_entry` belong to 001 and are referenced, not
redefined. `workflow_run`, `agent_run` and `runner_registration` belong to 012.

## Graph core

### architecture.graph_node

One row per graph participant, whatever its kind (R-01).

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK, minted — never derived from a path (R-12) |
| tenant_id | uuid | |
| node_kind | enum | `component` · `deployment_unit` · `repository` · `endpoint` · `feature` · `flow` · `external` |
| layer | enum | `code` · `runtime` · `product` (FR-004) |
| name | text | display name |
| natural_key | text | matching key across discovery runs; not identity |
| provenance | enum | `human_authored` · `human_confirmed` · `derived_from_trace` · `derived_from_runtime` · `derived_from_code` · `derived_from_config` · `inferred_from_convention` (FR-005) |
| strength | smallint | ordinal from the stored mapping (R-03). `NOT NULL` |
| confidence | smallint | integer 0–100, computed **at write time only** (R-15). `NOT NULL`. Never recomputed on a schedule: a versioned row whose confidence drifts with wall-clock time cannot be reproduced by a pinned query (FR-014, SC-005). Staleness is surfaced through `last_observed_at` and `lifecycle_state`, not by mutating the row |
| state | enum | `proposed` · `confirmed` · `rejected` · `stale` |
| lifecycle_state | enum | `active` · `unobserved` · `unresolved` · `possibly_removed` |
| observation_ref | uuid? | `evidence.id` (001 FR-007) — an evidence row of type `graph_fact`, written by the discovery step from the shape it received (FR-027) |
| actor_ref | text? | the named human, for the two human provenance classes |
| discovery_run_id | uuid? | which run produced it |
| valid_from_version, valid_to_version | int | validity range (R-04); open rows use `2147483647` |
| created_at | timestamptz | |

Constraints — written as boolean expressions, because Postgres has no `IMPLIES`; `a → b` is
`NOT a OR b`:

```sql
CHECK (provenance IN ('human_authored', 'human_confirmed') OR observation_ref IS NOT NULL)
CHECK (provenance NOT IN ('human_authored', 'human_confirmed') OR actor_ref IS NOT NULL)
```

The first says every non-human class carries an observation; the second says every human class carries
a named actor. An element with no provenance source cannot be persisted (FR-005, SC-001).

Indexes: `(tenant_id, node_kind, valid_from_version, valid_to_version)`,
`(tenant_id, natural_key)`, `(tenant_id, lifecycle_state) where lifecycle_state <> 'active'`.

### architecture.graph_edge

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| from_node_id, to_node_id | uuid | FK `graph_node` |
| edge_type | enum | `depends_on` · `calls` · `deploys` · `contains` · `implements` · `exposes` · `serves_feature` · `built_from` |
| layer | enum | `code` · `runtime` · `product` |
| provenance, strength, confidence | as above | `NOT NULL`; `strength` and `confidence` are the **maximum** over `edge_provenance` (FR-008, R-03) |
| state | enum | `proposed` · `confirmed` · `rejected` · `stale` |
| observation_count | bigint | how many observations support it (trace volume) |
| last_observed_at | timestamptz? | recency, an input to confidence |
| valid_from_version, valid_to_version | int | (R-04) |

Indexes: `(tenant_id, from_node_id, valid_from_version, valid_to_version)` and the mirror on
`to_node_id` — these two are the traversal's only access paths (R-01). Unique
`(tenant_id, from_node_id, to_node_id, edge_type, layer) where valid_to_version = 2147483647`.

### architecture.edge_provenance (append-only)

Every contributing observation for an edge, so a merged edge stays inspectable (FR-008).

`id`, `tenant_id`, `edge_id`, `provenance`, `strength`, `confidence`, `observation_ref` (`evidence.id`),
`adapter_key`, `adapter_version`, `discovery_run_id`, `recorded_at`.

The denormalised `strength` and `confidence` on `graph_edge` are the maximum over these rows;
keeping them on the edge is what lets the traversal stay a single self-join.

## Kind attributes

Keyed by `graph_node.id`, one row each. Nothing here is traversed.

### architecture.component_attr

`node_id`, `component_type` (`service` · `library` · `frontend` · `worker` · `job` · `datastore` ·
`external`), `characteristics` text[] (`stateful`, `user_facing`, `money_path`, `public_contract`,
`scheduled`, `third_party`, …), `owner_ref`.

No column describes the system's architecture as a single style (FR-001, D-09). `characteristics` is
an open set with a validated vocabulary, extended by configuration rather than by migration.

### architecture.deployment_unit_attr

`node_id`, `environment`, `runtime_kind` (`container` · `function` · `vm` · `static_site` ·
`managed_service`), `runtime_ref`, `current_version`, `last_deployed_at`.

### architecture.repository_attr

`node_id`, `vcs` (`gitlab`), `project_ref`, `default_branch`.

### architecture.endpoint_attr

`node_id`, `protocol` (`http` · `grpc` · `event` · `cli`), `method`, `path_template`, `contract_ref`.

### architecture.feature_attr

`node_id`, `description`, `product_owner_ref`. Product-layer nodes may only reach `confirmed` through
a human confirmation (FR-013, SC-002) — enforced by the same capability gate as every confirmation
(R-09) plus a check constraint on `graph_node`, again as a boolean expression rather than an
implication:

```sql
CHECK (layer <> 'product' OR state <> 'confirmed'
       OR provenance IN ('human_authored', 'human_confirmed'))
```

## Relationships expressed as edges

The separations the constitution requires are edges, not columns:

```text
Component  ──deploys──▶  DeploymentUnit     many-to-many across environments (FR-002)
Component  ──built_from──▶ Repository        many-to-many (FR-003)
Component  ──contains──▶ Component           a monolith's internal decomposition
Feature    ──serves_feature──▶ Endpoint      the human-confirmed seam (FR-013)
Endpoint   ──implements──▶ Component         route → handler → symbols → component
```

A monolith is therefore *n* `component` nodes, joined by `contains` edges, every one of them
carrying a `deploys` edge to a single `deployment_unit` node — the shape ADR 0007 says must be
expressible, expressed without a special case. A monorepo is *n* components with `built_from` edges
to one `repository`; a component assembled from two repositories is two `built_from` edges.

## Versioning

### architecture.graph_version

`id` uuid, `tenant_id`, `version` int (monotone per tenant, unique `(tenant_id, version)`),
`minted_by` (`confirmation` · `manual_edit` · `drift_resolution` · `rename`), `actor_ref`,
`draft_id?`, `note`, `created_at`.

Every query resolves against a version; omitting one resolves to the tenant's current version and
the response states which (FR-014, R-13).

## Discovery

### architecture.discovery_run

`id`, `tenant_id`, `base_version` int, `trigger` (`onboarding` · `scheduled` · `manual` ·
`post_deploy`), `runner_id` (012), `adapter_versions` jsonb, `started_at`, `finished_at`,
`outcome` (`complete` · `partial` · `failed`), `nodes_proposed`, `edges_proposed`.

### architecture.discovery_source_outcome

Per-source result in the same form as 003 FR-014 — which means **003's six statuses and 003's closed
reason codes**, not a parallel set: `run_id`, `source_key`, `status` (`collected` · `partial` ·
`unavailable` · `timed_out` · `withheld` · `not_attempted`), `reason_code` (the closed set of 003
`contracts/collection-plan.md`: `source_unreachable` · `auth_revoked` · `timeout` ·
`retention_exceeded` · `capability_unavailable` · `budget_exhausted` · `redaction_withheld` ·
`schema_rejected` · `empty_result`), `item_count`, `duration_ms`. A source discovery chose not to run
is `not_attempted`; there is no `skipped`. A run produces a draft from whatever was available
(FR-023).

### architecture.discovery_draft

`id`, `tenant_id`, `run_id`, `base_version` int, `state` (`open` · `applied` · `abandoned`),
`opened_at`, `closed_at?`, `review_seconds?` — the last recorded as the onboarding baseline
(SC-006a), alongside the proposal and accepted-unchanged counts it is reported with.

### architecture.draft_item

The draft **is** the diff (R-07).

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id, draft_id | uuid | |
| op | enum | `add_node` · `add_edge` · `modify_attributes` · `mark_removed` |
| target_node_id, target_edge_id | uuid? | null for an `add_*` of a new element |
| proposed | jsonb | schema-validated payload, no free-form customer text |
| current | jsonb? | confirmed state at `base_version`, so review is a two-column read |
| proposal_digest | text | structural digest; excludes confidence and observation counts (R-08) |
| provenance, strength, confidence | | carried from the observation |
| observation_ref | uuid? | `evidence.id` |
| state | enum | `proposed` · `confirmed` · `rejected` · `superseded` |
| decided_by, decided_at | text?, timestamptz? | human actor only (FR-010, R-09) |

Index `(tenant_id, draft_id, state)`, `(tenant_id, proposal_digest)`.

### architecture.proposal_rejection

`tenant_id`, `proposal_digest`, `rejected_by`, `rejected_at`, `reason`. Unique
`(tenant_id, proposal_digest)`. Discovery filters candidates against this table before writing draft
items (FR-011).

## Drift

### architecture.drift_finding

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| kind | enum | `observed_edge_absent` · `recorded_edge_contradicted` · `deployment_unit_missing` · `product_link_dangling` |
| recorded_side | jsonb | the graph's claim, with node/edge identifiers and its provenance |
| observed_side | jsonb | the contradicting observation |
| evidence_ids | uuid[] | 001 FR-007, both sides (FR-018) |
| issue_id | uuid | the `knowledge_drift` issue raised for adjudication (001 FR-001, R-14) |
| graph_version | int | the version the disagreement was found against |
| state | enum | `open` · `resolved_graph_updated` · `resolved_observation_rejected` · `dismissed` |
| resolved_by, resolved_at, resolution_version | | human actor, and the version the resolution minted |
| detected_at | timestamptz | |

No row in this table causes a graph write. The only path from a finding to the graph is a human
resolution, which mints a version and writes an audit entry (FR-018, FR-025, SC-007).

## Audit

Graph mutations write to `audit.audit_entry` (001 FR-012) with `target_type` of `graph_node`,
`graph_edge`, `draft_item` or `drift_finding`, the before and after payloads, the reason and the
minted `graph_version` (FR-025). This feature adds no second audit store.

### flow_attr

Attributes for nodes of kind `flow` — a named user-facing path through the product, which is
product-layer knowledge and therefore human-authored (005): `node_id` (PK), `name`,
`entry_component_id`, `ordered_step_refs` jsonb (component or endpoint references in order),
`owner`, `source_document_ref` (the markdown document it was adopted from).

A `flow` is never produced by discovery. It is adopted, like an `ExpectedBehavior`, because the
system cannot know which sequence of calls a human considers one journey.

## Invariants

- Every `graph_node` and `graph_edge` has a non-null provenance, strength and confidence, and a
  non-null `observation_ref` or `actor_ref` according to its class. Checked continuously (SC-001).
- Every non-null `observation_ref` on `graph_node`, `edge_provenance` or `draft_item` resolves to an
  `evidence` row of type `graph_fact` whose producing step is the discovery step that received the
  shape (FR-027, 001 FR-008). Checked continuously by `check:graph-fact-coverage`.
- `graph_edge.strength` and `.confidence` equal the maximum over that edge's `edge_provenance`
  rows. A continuous check compares them; drift between them means a merge wrote the wrong value.
- No `graph_node` or `graph_edge` row moves to `state = 'confirmed'` without a `draft_item` whose
  `decided_by` names a human actor, or an audited manual edit by one (FR-010, SC-002, SC-003).
- A discovery run never writes a row with `state = 'confirmed'`. Enforced by the write path's
  permitted state set, and verified by a check over `audit_entry` actor types (FR-009).
- A product-layer node or `serves_feature` edge in `state = 'confirmed'` has a human provenance
  class (FR-013, SC-002).
- Validity ranges never overlap for the same logical element: at most one row per
  `(tenant_id, from_node_id, to_node_id, edge_type, layer)` has `valid_to_version = 2147483647`.
- Every `drift_finding` in state `open` has an `issue_id` resolving to an open `knowledge_drift`
  issue (001 FR-001a).
- A closure result's confidence equals the minimum edge confidence on its recorded path. Verified by
  a property test over generated graphs, not only by example (SC-004).
- Every read is constrained by `tenant_id` from the authenticated context; a foreign identifier
  returns not-found (FR-024, SC-009).

## T002 implementation notes (deviations from the field lists above)

- **Every attr table carries `tenant_id`.** The per-table field lists above key `component_attr`,
  `deployment_unit_attr`, `repository_attr`, `endpoint_attr`, `feature_attr` and `flow_attr` purely
  by `node_id`. `prisma-migrations.md`'s inviolable rule ("every tenant-scoped table has
  `tenant_id` and a leading index"), enforced continuously by `prisma/migration.e2e.test.ts`,
  applies to these tables too — a table missing it fails `make db-check`. `tenant_id` is
  denormalized onto all six, each with its own leading `(tenant_id)` index.
- **`discovery_source_outcome` carries `tenant_id`.** Its own field list above omits it, unlike
  `discovery_draft`'s and `draft_item`'s, which both list `tenant_id` explicitly next to their
  `run_id`/`draft_id` — the omission reads as an oversight rather than a decision. Added for the
  same inviolable-rule reason as above, with a leading `(tenant_id, run_id)` index.
- **`graph_edge` gets two interim tenant-leading indexes at T002**: `(tenant_id, from_node_id)`
  and `(tenant_id, to_node_id)`, satisfying the same rule before `valid_from_version`/
  `valid_to_version` exist. T008 drops both and replaces them with the version-aware composite
  indexes this document already specifies as the traversal's real access paths.
- **`discovery_draft`'s SC-006a columns are named here for the first time**: `proposals_count`,
  `accepted_unchanged_count`, alongside `review_seconds`. The prose above names the concepts
  ("the proposal and accepted-unchanged counts it is reported with") without naming columns.
- **`proposal_rejection`'s primary key is the composite `(tenant_id, proposal_digest)`** rather
  than a surrogate `id` — that pair is already the table's one required uniqueness and every
  lookup is by it.
- **`edge_provenance` has no `actor_ref` column**, matching this document's field list for that
  table exactly — but that list also has no field at all for naming a human actor, unlike
  `graph_node`/`graph_edge`'s explicit `actor_ref`. A `human_authored`/`human_confirmed`
  `edge_provenance` row (if one is ever written — humans normally author `graph_node`/`graph_edge`
  directly, not through discovery's per-observation path) would carry neither an observation nor
  an actor. Flagged for review rather than resolved unilaterally; `observation_ref` is nullable to
  avoid blocking on it.
