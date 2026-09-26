# Data Model: knowledge sources, provenance and expected behaviour

Schema `knowledge`. Identifiers are UUID v7; timestamps `timestamptz` UTC. Every table carries
`tenant_id` with an index leading on it (012 FR-048).

`issue`, `evidence`, `evidence_link` and `audit_entry` belong to 001. `graph_node` (components,
features, endpoints) belongs to 004. `tenant_budget`, `prompt_version` and `agent_run` belong to 012.
All are referenced, never redefined.

## Sources and documents

### knowledge.knowledge_source

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| kind | enum | `repository_markdown` · `git_history` · `merge_request` · `ticket` · `incident_history` · `openapi` · `test_names` · `runbook` · `postmortem` · `hosted_wiki` |
| adapter_key | text | `gitlab`, `openapi` — the v1 set (C-06) |
| connection_state | enum | `connected` · `disconnected` · `error` |
| sync_state | enum | `idle` · `syncing` · `failed` |
| last_successful_sync_at | timestamptz? | |
| document_classes | text[] | what this source yields |
| implemented | bool | `false` for a declared but unimplemented kind |

`hosted_wiki` exists in the enum and ships with `implemented = false` (C-06). The abstraction is
real from day one; the adapter is not, and a disabled kind is visible as a gap rather than as an
absence someone has to remember.

### knowledge.knowledge_document

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| source_id | uuid | FK `knowledge_source` |
| external_ref | text | path, page id or ticket key in the source |
| title | text | |
| document_class | enum | `expectation` · `runbook` · `postmortem` · `design_doc` · `readme` · `ticket` · `merge_request` · `api_description` · `test_manifest` |
| provenance | enum | `human_authored` · `machine_generated` · `machine_generated_adopted` (FR-007) |
| current_version_id | uuid | FK `document_version` |
| duplicate_group_id | uuid? | FK `duplicate_group` (FR-020) |
| component_node_id | uuid? | `graph_node` in 004 — never a service name |
| availability | enum | `available` · `unavailable` (source disconnected) · `deleted_at_source` |
| source_modified_at, last_synced_at, last_verified_at | timestamptz? | freshness (FR-018, R-09) |
| owner_ref | text? | the named human owner every generated draft must have (FR-021, D-23) |

`provenance` is immutable except through a recorded adoption, which moves `machine_generated` to
`machine_generated_adopted` in the same transaction that writes the grant (FR-007). That transaction
transitions `knowledge_constraint.provenance` for the constraints the adopted version carries in the
**same write** — see `knowledge_constraint` below.

Indexes: `(tenant_id, source_id, external_ref)` unique, `(tenant_id, document_class)`,
`(tenant_id, component_node_id)`.

### knowledge.document_version (append-only)

`id`, `tenant_id`, `document_id`, `version_no` int, `content_hash` text, `captured_at`,
`source_modified_at?`, `author_ref?` (git commit author, for repository sources — R-02),
`commit_sha?`, `supersedes_id?`.

Never updated. A citation pins a `document_version.id` (FR-019); a consumer holding a pinned
citation to a superseded version is told it is stale rather than served current content.

### knowledge.document_section

`id`, `tenant_id`, `document_version_id`, `ordinal` int, `heading_path` text[], `content` text,
`char_start`, `char_end`, `search_vector` tsvector (generated column).

The addressable unit (spec edge case: a 400-page handbook is sections, never one blob). Retrieval
returns a section with its position, never a whole document. GIN index on `search_vector` with
`tenant_id` leading a composite for the lexical path (R-06).

### knowledge.section_embedding

`section_id`, `tenant_id`, `embedding vector(1024)`, `model_ref`, `built_at`. The dimension is fixed in
the column (R-15) — a `vector(N)` column has one width, so a configurable dimension is not a thing
that exists. `model_ref` records which model produced the row, which is what makes a future second
model a backfill rather than a reset.

**Partitioned by list on `tenant_id`**, HNSW index per partition (R-05). Holds no content: it can be
truncated and rebuilt from `document_section` at any time, which is what makes ADR 0004's "secondary
index, never a source of truth" checkable rather than aspirational (SC-004).

### knowledge.duplicate_group

`id`, `tenant_id`, `canonical_document_id`, `method` (`content_hash` · `trigram`), `threshold`,
`detected_at`. Non-canonical members stay retrievable and linked, so a citation to any of them
resolves (FR-020, R-10).

## Expected behaviour

### knowledge.expected_behavior

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| stable_key | text | `checkout-002` — carried across edits and renames (R-08). Unique `(tenant_id, stable_key)` |
| feature_node_id | uuid? | `graph_node`, product layer in 004 |
| component_node_id | uuid? | `graph_node` in 004 |
| state | enum | `draft` · `adopted` · `superseded` · `retired` (FR-009) |
| current_version_id | uuid | FK `expected_behavior_version` |
| seeding_session_id | uuid? | which onboarding run produced it |
| created_at | timestamptz | |

`state` exists for display and for lifecycle queries. **It is not what makes an anchor.** No anchor
query reads it (R-01).

### knowledge.expected_behavior_version (append-only)

`id`, `tenant_id`, `expected_behavior_id`, `version_no` int, `description` text, `content_hash`,
`document_version_id` (the markdown version it came from), `provenance`
(`human_authored` · `machine_generated`), `extraction_key?` (R-12), `extraction_rule?`,
`source_artifact_ref?`, `created_at`.

An edit creates a version. A version has no anchor grant until it is itself adopted (FR-012).

### knowledge.anchor_grant

**The table Principle II rests on.** 008 references `anchor_grant.id`; there is no other way to name
an anchor (R-01).

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| expected_behavior_version_id | uuid | FK, unique — one grant per adopted version |
| adoption_record_id | uuid | FK, `NOT NULL` |
| granted_at | timestamptz | |
| revoked_at | timestamptz? | **the one authoritative revocation record**; set once, only by the human revocation command (FR-013, R-09) |
| revoked_by | text? | the human who revoked; `NOT NULL` whenever `revoked_at` is set |
| revocation_reason | text? | same rule |

Anchor lookup is `WHERE tenant_id = $1 AND revoked_at IS NULL`. A revoked grant still resolves by
id, so a completed verification's audit record stays readable (FR-013).

**Revocation lives here and nowhere else.** There is no `adoption_revocation` table and no
`adoption_record.revocation_id`: three places recording one act, with the tasks writing two of them,
is three chances to disagree about whether an anchor is live — and the anchor lookup is the one query
in the product that must not be wrong. Everything a reader wants is derived from these three columns:
"was this adoption revoked, by whom, why and when" is `anchor_grant` joined to `adoption_record`, and
the revocation's audit entry (001 FR-012) carries the actor and reason as it does for every mutation.
`CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))` keeps a revocation from existing without an
owner.

No row is created outside the adoption transaction, and **no scheduled job may write to this table** —
an anchor that expired on a timer would make a verification verdict depend on the clock.

### knowledge.adoption_record (append-only)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| expected_behavior_version_id | uuid | the exact content version adopted (FR-011) |
| actor_type | enum | `human` only — the column exists so the constraint can name it |
| actor_ref | text | `NOT NULL`. For repository sources, the merge request approver (R-02) |
| approval_ref | text? | merge request and approval identifiers |
| merge_commit_sha | text? | |
| seeded_from | jsonb | the source artifacts the draft was derived from (FR-011) |
| adopted_at | timestamptz | |

`CHECK (actor_type = 'human')` and a check that `actor_ref` is not Healer's service identity — the
one approval a machine could give itself (R-02, SC-002).

No revocation column: revocation is `anchor_grant.revoked_at` and is read from there through the
grant. An adoption record is a fact about an act that happened and never changes.

## Constraints

### knowledge.knowledge_constraint

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| scope_kind | enum | `feature` · `component` · `expected_behavior` |
| scope_ref | uuid | |
| name | text | `max_payment_retries` |
| value_type | enum | `int` · `decimal` · `bool` · `duration` · `string` · `enum` |
| value_json | jsonb | typed, parsed from front matter — never from prose (R-08, R-11) |
| document_version_id | uuid | the defining version |
| provenance | enum | `human_authored` · `machine_generated` · `machine_generated_adopted` |
| anchor_grant_id | uuid? | non-null makes it an **authoritative** value (FR-008, FR-014) |

The adoption transaction writes **three things, not two**: the `anchor_grant`, the document's
`provenance` transition, and `provenance` plus `anchor_grant_id` on every `knowledge_constraint` the
adopted `expected_behavior_version` carries. Without the third, the invariant below — an anchored
constraint has a human or adopted provenance — is violated by the adoption path itself: the constraint
would acquire a grant and keep `machine_generated`. Deriving it from the grant at read time was the
alternative and was rejected, because the resolver would then compute provenance instead of reading it,
on the one path a policy predicate depends on.

**No unique index on `(tenant_id, scope_ref, name)`** — a conflict must be representable so it can be
reported rather than prevented at ingest (FR-015, R-07). The resolver counts authoritative rows: one
returns a value, more than one returns `CONSTRAINT_CONFLICT` naming every definition, zero returns
not-found.

Index `(tenant_id, scope_kind, scope_ref, name)`.

## Retrieval

### knowledge.trust_tier_rule

`id`, `question_type` (`current_behavior` · `intended_behavior`), `rule_set_version` int,
`source_class` **enum**, `tier` smallint, `note`. The constitution's two orderings, stored (FR-005,
R-04):

```text
current_behavior    1 observed reality · 2 code and tests · 3 verified incidents
                    4 human-authored documents · 5 machine-generated documents

intended_behavior   1 adopted ExpectedBehavior · 2 human-written acceptance tests
                    3 code · 4 observed reality · 5 machine-generated documents
```

`source_class` is a **closed enum, not bare `text`**, and every member names the route by which a
candidate of that class actually reaches the ranker. A tier row whose class has no route ranks nothing,
and the point of writing the routes down is that this is visible rather than discovered by a customer:

| `source_class` | Route into retrieval | In v1 |
|----------------|----------------------|-------|
| `observed_behavior` | the `ObservedBehaviorQuery` port into 001/003 `Evidence`, returned as `kind: 'observation'` (C-21, FR-029) | yes |
| `verified_incident` | the same port, restricted to evidence linked to a resolved issue that carries verification evidence (001) | yes |
| `acceptance_test` | document class `test_manifest` with `provenance = human_authored` — a test a human wrote | yes |
| `test` | document class `test_manifest` from the `test_names` source | yes |
| `adopted_expectation` | `expected_behavior_version` with a live `anchor_grant` — not a document at all | yes |
| `human_document` | document classes `runbook` · `postmortem` · `design_doc` · `readme` · `ticket` · `merge_request` · `api_description` with `provenance = human_authored` | yes |
| `machine_document` | the same classes with `provenance = machine_generated` | yes |
| `code` | **none** | **no** |

**What supplies `code` in v1: nothing.** There is no code knowledge adapter — the v1 adapter set is
GitLab (repository markdown, git history, merge requests, issues) and OpenAPI/test names (C-06, spec
assumptions). 004's `derived_from_code` graph facts and 008's AST reads are evidence and graph
elements, not retrievable knowledge documents, and turning either into one would be inventing a
document from source that has no author, no version to pin and no adoption. So the `code` rows exist in
both rule sets, rank nothing, and are the honest declaration of a gap: `current_behavior` tier 2 and
`intended_behavior` tier 3 are half-populated in v1, by `test` and `acceptance_test` respectively. A
code adapter is post-v1, and when it lands the tier rows already exist.

A rule set is never edited; a change is a new `rule_set_version`, so a stored query reproduces its
ordering (SC-005).

### knowledge.retrieval_query (append-only)

`id`, `tenant_id`, `issue_id?`, `question_type` (**`NOT NULL`** — FR-004), `terms`, `scope_filters`
jsonb, `rule_set_version`, `paths_used` text[] (`structural`/`lexical`/`vector`), `complete` bool,
`unconsulted_sources` text[], `budget_ref?` (002 FR-011), `executed_at`, `requested_by_step`.

The record that makes a ranking reproducible. `complete = false` with named unconsulted sources is
how a budget-constrained retrieval degrades visibly (FR-028, R-13).

### knowledge.retrieval_result (append-only)

`query_id`, `rank` int, `kind` (`document` · `observation` — FR-029, C-21), `document_version_id?`,
`section_id?`, `matched_span?` int4range, `evidence_id?`, `observed_at?`, `tier`, `rule_id`,
`score` numeric, `provenance?`, `freshness?` jsonb (the three timestamps at time of use),
`path` (`structural` · `observation` · `lexical` · `vector`), `anchor_grant_id?`.

`CHECK (kind = 'observation' OR (document_version_id IS NOT NULL AND section_id IS NOT NULL))` and
`CHECK (kind = 'document' OR (evidence_id IS NOT NULL AND document_version_id IS NULL
AND section_id IS NULL AND provenance IS NULL))` — an observation has no document version, no section
and no document provenance, and the row shape says so rather than leaving nulls to a convention.

A result that supports a persisted conclusion is written as an `evidence` row of type
`document_excerpt` by the retrieving step (FR-025, 001 FR-007, 001 FR-008) — this table is the
retrieval record, not a second evidence store.

## Drift and onboarding

### knowledge.knowledge_drift_finding

`id`, `tenant_id`, `kind` (`document_contradicts_code` · `document_contradicts_observation` ·
`constraint_value_conflict` · `expectation_references_missing_element`), `document_version_id?`,
`expected_behavior_version_id?`, `recorded_side` jsonb, `observed_side` jsonb, `evidence_ids` uuid[],
`issue_id` (the `knowledge_drift` issue — 001 FR-001, R-14), `state` (`open` ·
`resolved_document_updated` · `resolved_observation_rejected` · `dismissed`), `resolved_by`,
`resolved_at`, `detected_at`.

No row here edits a document or opens a change proposal (FR-017, SC-008).

### knowledge.seeding_session

`id`, `tenant_id`, `feature_node_id?`, `input_classes_present` text[], `input_classes_absent` text[],
`proposed_count`, `adopted_unchanged_count`, `edited_count`, `discarded_count`, `review_seconds`,
`started_at`, `finished_at`.

Queryable as the S0-5 onboarding baseline (FR-024, SC-009). The counts are the measurement that
decides whether product verification works in practice at all.

## knowledge.retrieval_config

Per-tenant keys other features read rather than inventing their own thresholds.

| Key | Type | Consumed by |
|-----|------|-------------|
| `knowledge.answer_trust_floor` | `source_class` ordinal | 009 answer policy predicate 2 — the minimum trust tier a citation may come from |
| `knowledge.freshness_window` | interval per `source_class` | 009 predicate 2 — how old a citation of that class may be |
| `knowledge.retrieval_limit` | int | default result count |

Starting values are pilot-tuned ([stage-0](../../docs/stage-0.md) S0-7), not constants. Exposed on
every retrieval result so a consumer can state *which* floor a citation passed rather than asserting
that it passed one.

## Invariants

- Every anchor reference resolves to an `anchor_grant` whose `adoption_record.actor_type` is `human`.
  There is no other path to an anchor (FR-010, SC-001).
- No `anchor_grant` row is written outside an adoption transaction, and `revoked_at` is written only
  by the revocation command. No scheduled job appears in the writer set (R-09).
- Revocation is recorded in exactly one place — `anchor_grant.revoked_at` / `revoked_by` /
  `revocation_reason`, set once. No second table and no column on `adoption_record` records it.
- 0 `adoption_record` rows name Healer's service identity as approver (R-02, SC-002).
- 0 anchor grants exist whose adoption transaction did not also transition the `provenance` of the
  `knowledge_constraint` rows carried by the adopted version (FR-007, FR-008).
- `document_version` and `expected_behavior_version` are never updated. An edit is a new row.
- A `knowledge_constraint` with a non-null `anchor_grant_id` has a `provenance` of `human_authored`
  or `machine_generated_adopted` (FR-008).
- Every `retrieval_query` row has a non-null `question_type`; the column is `NOT NULL` and the DTO
  has no default (FR-004).
- Every `retrieval_result` with `kind = 'document'` resolves to a retrievable `document_version` or to
  an `evidence` row in `detached` state (001 FR-010, SC-003); every row with `kind = 'observation'`
  resolves to an `evidence` row and carries no document version (FR-029).
- `section_embedding` holds no content and can be truncated without data loss. Verified by running
  the retrieval suite against a dropped index (SC-004).
- Every open `knowledge_drift_finding` has an open `knowledge_drift` issue (001 FR-001a).
- Every read is constrained by `tenant_id` from the authenticated context — including the ANN scan,
  which runs inside a tenant partition rather than filtering a global result (FR-027, R-05).
