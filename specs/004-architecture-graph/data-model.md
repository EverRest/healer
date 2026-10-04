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
| observation_ref | uuid? | `evidence.id` (001 FR-007) of type `graph_fact` — the observation this row was founded from (C-87). Set once, by `mergeObservation`; never updated afterward, same as `graph_node`'s |
| actor_ref | text? | the named human, for the two human provenance classes (C-87) |
| valid_from_version, valid_to_version | int | (R-04) |

Constraints (C-87, mirrors `graph_node`'s T006 pair exactly):

```sql
CHECK (provenance IN ('human_authored', 'human_confirmed') OR observation_ref IS NOT NULL)
CHECK (provenance NOT IN ('human_authored', 'human_confirmed') OR actor_ref IS NOT NULL)
```

Indexes: `(tenant_id, from_node_id, valid_from_version, valid_to_version)` and the mirror on
`to_node_id` — these two are the traversal's only access paths (R-01). Unique
`(tenant_id, from_node_id, to_node_id, edge_type, layer) where valid_to_version = 2147483647`.

### architecture.edge_provenance (append-only)

Every contributing observation for an edge, so a merged edge stays inspectable (FR-008). A
confirmed edge carries **two** rows once confirmed (C-87): the machine observation that proposed
it (written through `mergeObservation`, unchanged by confirmation) and a separate human
confirmation row (`provenance: human_confirmed`, `actor_ref` set, `observation_ref` null) — the
"keep the machine row" decision. `check:edge-strength-max`'s MAX naturally resolves to the human
row afterward (`human_confirmed` outranks every machine class, R-03), so `graph_edge.provenance`
becomes `human_confirmed` without a second write path for that column.

`id`, `tenant_id`, `edge_id`, `provenance`, `strength`, `confidence`, `observation_ref` (`evidence.id`),
`actor_ref` (C-87, text?, the named human for the two human classes), `adapter_key`,
`adapter_version`, `discovery_run_id`, `observation_count` (what this observation contributed),
`last_observed_at`, `recorded_at`, `valid_from_version`/`valid_to_version` (C-87, R-04a: the same
validity range as the edge row this observation was recorded against; open rows use
`2147483647`).
The edge's `observation_count` is the SUM and its `last_observed_at` the MAX over these rows, and its `provenance` class is the strongest row's (ties: earliest `recorded_at`, then `id`) — all three checked by `check:edge-strength-max`.

The denormalised `strength` and `confidence` on `graph_edge` are the maximum over these rows;
keeping them on the edge is what lets the traversal stay a single self-join.

Unique `(tenant_id, edge_id, observation_ref)`: an observation is recorded at most once per edge, so a
job that runs twice cannot double-count `graph_edge.observation_count` (004 T038). The merge path
locks the edge row (`SELECT ... FOR UPDATE`) before inserting, because the trigger that maintains the
maximum computes it from a statement snapshot and two unserialised writers would lower the edge.

Constraints (C-87, mirrors the observation-ref CHECK already here):

```sql
CHECK (provenance IN ('human_authored', 'human_confirmed') OR observation_ref IS NOT NULL)
CHECK (provenance NOT IN ('human_authored', 'human_confirmed') OR actor_ref IS NOT NULL)
```

**C-87's `valid_from_version`/`valid_to_version` "copy forward on edge closure" half (R-04a) is
not yet built** — there is no edge-closing mutation in this phase that would need to copy
surviving provenance forward with a new range (R-04's `manual_edit`/`drift_resolution` paths are
future phases). Every row written so far (by `mergeObservation` or by a confirmation) carries the
edge's *current* `valid_from_version` and the open sentinel; the copy-forward behaviour activates
the day an edge row is first closed and superseded.

### architecture.confidence_config

`tenant_id` (PK), `config` jsonb (only the overridden R-15 constants), `updated_at`. A tenant with no
row uses the defaults in `domain/edge-confidence.ts`. Read at write time only (004 T039).

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

**T026 implementation note**: `audit.audit_entry` (001's table) had no column for "before and after
payloads" or "the minted graph_version" — three nullable columns (`before`, `after` jsonb,
`graph_version` int) added via migration `20261004010000_t026_audit_entry_before_after`, additive,
documented in both this file and 001's `data-model.md` (same precedent as T018's `evidence.issue_id`
change). `confirmDraftItems` writes one `audit_entry` row per applied item with `before` set to the
draft item's own `current` snapshot and `after` to what was written; `rejectDraftItems` writes one
per rejected item with `after: null` and no `graph_version` (rejection mints none).

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
  denormalized onto all six, each with its own leading `(tenant_id)` index. **Review fix:** the
  six FKs to `graph_node` originally referenced `graph_node(id)` alone rather than the composite
  `(id, tenant_id)` every other child table in this migration uses — reproduced against live
  Postgres (a `component_attr` row naming one tenant while pointing `node_id` at another tenant's
  `graph_node` row was accepted). Fixed to `FOREIGN KEY (node_id, tenant_id) REFERENCES
  graph_node(id, tenant_id)` on all six, which required adding `@@unique([nodeId, tenantId])` to
  each attr model (Prisma's one-to-one relation validity rule) even though `node_id` alone is
  already the primary key — same redundant-but-required shape as `graph_node`/`graph_edge`'s own
  `@@unique([id, tenantId])` alongside their single-column `@id`.
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
- **Resolved by C-87**: `edge_provenance` now has an `actor_ref` column (and a validity range,
  R-04a) — the gap this bullet originally flagged. A confirmed `add_edge` writes a
  `human_confirmed` `edge_provenance` row with `actor_ref` set and `observation_ref` null,
  distinct from the machine row `mergeObservation` wrote (see "architecture.edge_provenance"
  above and prisma-draft-review-repository.ts's `add_edge` confirm handling).

## Phase 3 implementation notes (T018–T035 write path, sub-batch A1)

- **`evidence.evidence.issue_id` is now nullable**, with `CHECK (issue_id IS NOT NULL OR type IN
  ('graph_fact', 'collection_gap'))` (migration
  `20261004000000_t018_t035_discovery_evidence_and_draft_checks`). Discovery evidence has no
  issue — a `graph_fact` is what the step observed about the architecture, and the `collection_gap`
  rows a non-`collected` source produces name a source and a reason, not an issue. 001's own
  `data-model.md` is updated with the same line (004 changed 001's table, documented in both
  places per the plan). `down.sql` deletes every issue-less row before restoring `NOT NULL` —
  reversing this migration discards discovery evidence, a deliberate, documented cost.
- **`draft_item` gets three CHECK constraints** in the same migration (Prisma cannot express
  CHECK): every non-human-provenance item names its `observation_ref` (mirrors `graph_node`'s
  T006 CHECK); `state IN ('confirmed','rejected')` is exactly equivalent to `decided_by`/
  `decided_at` both being set (boolean equality, not two independent facts that could disagree);
  and every op but `add_node`/`add_edge` names a target (`target_node_id`/`target_edge_id`).
- **Evidence id is deterministic**: `sha256(tenantId|runId|kind|canonicalJSON(shape))`,
  UUID-formatted (`graph-fact-id.ts`). The draft-item diff builder computes a draft item's
  `observation_ref` purely, without a database round trip, and a retried ingest of the same batch
  computes identical ids — `createMany({ skipDuplicates: true })` is what makes the retry a no-op
  rather than a duplicate.
- **`mark_removed` items need a provenance and an observation despite observing nothing new** (the
  CHECK above requires it). Judgment call, not stated by the plan: the triggering fully-`collected`
  source's own adapter provenance is stamped on the item, and a synthetic **absence** `graph_fact`
  evidence row is written (`payload: { kind: 'absence', ... }`) — not one of the four boundary
  shapes, which only declare what *was* observed. **[PAVLO]** whether an "absence" fact deserves
  its own boundary-contract shape (so it is validated the same way) rather than a free-standing
  payload written only by this package — recorded in QUESTIONS.md.
- **`repository_attr` has no `headSha` column** (confirmed by this document's own field list,
  which never named one) — `RepositoryAttributes` (the domain type compared for `modify_attributes`
  diffing) therefore excludes `headSha` entirely rather than merely excluding it from
  `proposal-digest.ts`'s hash. Stronger than the plan's instruction (digest-only exclusion):
  unrepresentable rather than merely unhashed (docs/patterns.md). `headSha` still rides inside the
  `repository_ref` shape's own `graph_fact` evidence payload — it is observed and recorded, just
  never compared as a node attribute.
- **Confidence (R-15) uses `provenance_base` only** in this phase (`confidence.ts`,
  `CONFIDENCE_PROVENANCE_BASE_V1`) — `observation_term`/`staleness_term` are T039 (Phase 4),
  flagged with a `ponytail:` comment naming it.
- **The adapter-constant cross-check and closed-vocabulary validation are independent of
  `validateEgress`** (`ingest-discovery-batch.ts`): a `component_candidate` whose `adapterKey`
  names a different source than the one it arrived under, a `dependency_observation` whose
  `provenance`/`layer` disagree with its adapter's fixed constants, a `dependency_observation`
  targeting `layer: 'product'` (FR-013), or a `componentType`/`runtimeKind`/`edgeType` outside this
  package's own closed lists (`closed-vocabularies.ts`) are each `schema_rejected` — downgrading a
  `collected` source to `partial` the moment ingestion rejects even one of its items.
