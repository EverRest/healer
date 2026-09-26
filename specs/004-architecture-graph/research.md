# Phase 0 Research: system model and architecture discovery

## R-01 · One node table and one edge table

**Decision**: every graph participant — component, deployment unit, repository, endpoint, feature,
flow, external system — is a row in `graph_node` with a `node_kind`, and its kind-specific
attributes live in a side table keyed by the same identifier. Every relationship is a row in
`graph_edge` referencing `from_node_id` and `to_node_id`.

**Rationale**: blast radius is the query that decides whether a change is safe, and it must be one
recursive CTE self-joining one table. With entity-typed relationship tables — `component_depends_on`,
`component_deployment`, `endpoint_handler` — the same traversal becomes a recursive union over five
relations, which Postgres cannot index as one access path and which grows a new branch every time a
node kind is added. The side-table split keeps the traversal narrow: the recursive term touches
`graph_edge` only, and attributes are joined once at the end against the result set.

**Alternatives**: a graph database (rejected by ADR 0004 and D-05 — these graphs are thousands of
nodes, and a second store is a second thing to secure per tenant); adjacency lists denormalised onto
the component row (breaks the moment an edge needs its own provenance, which is every edge here).

## R-02 · The weakest edge is computed by the traversal, not after it

**Decision**: the recursive term carries `LEAST(path_confidence, edge.confidence)` and
`LEAST(path_strength, edge.strength)` forward, together with the node path as an array. A result row
therefore arrives already carrying the confidence of the weakest edge that produced it (FR-015,
SC-004).

```sql
WITH RECURSIVE reach AS (
  SELECT e.to_node_id, e.confidence, e.strength,
         ARRAY[e.from_node_id, e.to_node_id] AS path, 1 AS depth,
         (e.state <> 'confirmed') AS crossed_unconfirmed
  FROM architecture.graph_edge e
  WHERE e.tenant_id = $tenant AND e.from_node_id = $root
    AND $version BETWEEN e.valid_from_version AND e.valid_to_version
  UNION ALL
  SELECT e.to_node_id,
         LEAST(r.confidence, e.confidence), LEAST(r.strength, e.strength),
         r.path || e.to_node_id, r.depth + 1,
         r.crossed_unconfirmed OR e.state <> 'confirmed'
  FROM reach r
  JOIN architecture.graph_edge e
    ON e.tenant_id = $tenant AND e.from_node_id = r.to_node_id
   AND $version BETWEEN e.valid_from_version AND e.valid_to_version
  WHERE NOT e.to_node_id = ANY(r.path) AND r.depth < $max_depth
)
```

**Rationale**: the alternative is to return paths and let each consumer compute the minimum.
Four consumers computing a minimum is four chances to compute a maximum, an average, or the
confidence of the last edge — and the failure is silent, because a plausible number comes out
either way. Computing it in the recursion also means the value cannot be dropped in transport: the
column exists or the query does not compile.

**Alternatives**: post-processing paths in TypeScript (loses the guarantee, and ships whole paths
over the wire for large radii); storing a precomputed transitive closure (invalidation on every
confirmed edge change, and it would have to be recomputed per graph version).

## R-03 · Strength is a stored ordinal, and the ordering is deliberate

**Decision**: `graph_edge.strength` and `graph_node.strength` are `smallint` ordinals written at
insert time from the provenance class, using a versioned mapping:

| Ordinal | Provenance class | What it means |
|---------|------------------|---------------|
| 70 | `human_confirmed` | a named human accepted a proposal |
| 65 | `human_authored` | a named human asserted it with no inference behind it |
| 50 | `derived_from_trace` | observed in distributed traces (003, OpenTelemetry) |
| 40 | `derived_from_runtime` | observed in the runtime — Kubernetes, deploy records |
| 30 | `derived_from_code` | AST, imports, type graph |
| 20 | `derived_from_config` | manifests, service definitions, CI configuration |
| 10 | `inferred_from_convention` | folder layout, naming, ownership files |

**Rationale for storing it**: a query pinned at an old graph version (FR-014, SC-005) must reproduce
the ordering that existed then. Deriving the ordinal from the enum at read time means the day the
mapping is tuned, every historical answer changes and every past explanation becomes wrong.

**Rationale for the ordering**: observed outranks derived outranks inferred, which is the
constitution's hierarchy for "what does the system actually do". The human classes sit above them,
and this is not a contradiction of that hierarchy: it is the same rule that makes an adopted
`ExpectedBehavior` an anchor. A human-confirmed edge is accountable — a named person owns it, and
when observation contradicts it the graph is not silently corrected, drift is raised for that person
(FR-012, FR-017). Observation therefore still wins over a stale human claim; it wins *through a
human*, which is the only safe direction. What would contradict the constitution is a confirmed edge
that observation can never dislodge, and FR-017 forbids exactly that.

**Alternatives**: a single float confidence with no class (loses the ability to say *why* an edge is
weak, which is the review affordance User Story 2 exists for); ordering computed per query from
tenant configuration (makes SC-005 unachievable).

## R-04 · Graph versions are validity ranges, not snapshots

**Decision**: `graph_version` holds a per-tenant monotone integer minted by each confirmation
transaction. Every node and edge row carries `valid_from_version` and `valid_to_version` (open rows
use `2147483647`). A version-pinned query adds `$version BETWEEN valid_from_version AND
valid_to_version`; a mutation closes the old row and inserts a new one.

**Rationale**: a version is minted on every confirmation and every human edit, so a tenant produces
thousands of versions in a year. A snapshot table multiplies the graph by that number. Two integers
per row and a composite index cost nothing and make a pinned historical traversal use the same plan
as a current one.

Two plain integer columns rather than an `int4range` with a GiST index: the query is a pair of
inequalities on a btree index that already leads on `(tenant_id, from_node_id)`, and a range type
would buy exclusion constraints this model does not need.

**Alternatives**: full snapshots (storage and a second write path); event sourcing the graph
(reconstructing state for every query, and a traversal over a replayed log is not a CTE);
`valid_from`/`valid_to` timestamps (two confirmations in the same millisecond become ambiguous, and
an evidence record or impact analysis needs to pin an *identity*, not a moment).

## R-04a · Provenance rows carry their own validity range

**Decision**: `edge_provenance` rows carry the same `valid_from` / `valid_to` range as the edge they
describe, and when a mutation closes an edge row and inserts a successor, **surviving provenance is
copied forward with a new range** while provenance that no longer holds is closed. A version-pinned
inspection therefore reads the provenance that was true at that version.

**Rationale**: R-04 versions edges as validity ranges, but without the same treatment on provenance
a historical inspection reports today's provenance against yesterday's edge — which is worse than no
history, because it looks authoritative. Copying forward is cheap; provenance rows are small and few
per edge.

**Alternatives**: pointing provenance at a stable logical edge key rather than the row (loses the
ability to say when a provenance began, which is what recency scoring needs).

## R-05 · C-03 is made inexpressible, not checked

**Decision**: traversal is exposed as two distinct, non-interchangeable result types.

- `ImpactClosure` — traverses **every** edge in scope regardless of state, provenance or confidence.
  It has no strength or confidence parameter. It is the only type accepted by an impact
  classification input (008 FR-003), a policy predicate input (002 FR-003) or a risk computation.
- `KnownSubgraph` — the filtered view, `strength >= x` or `confidence >= y`, satisfying FR-016.
  It is an explanation and display type. No predicate signature, no policy input schema and no
  approval condition accepts it, and there is no conversion between the two.

Because `ImpactClosure` cannot be narrowed, adding an unconfirmed edge can only add members: the
closure is monotone in the edge set by construction. Every derived quantity a permission depends on
is therefore antitone or monotone in the safe direction — radius size only grows, "touches nothing
of class X" only becomes harder to satisfy, "stays within the allowlist" only becomes harder to
satisfy.

**002 owns the predicate vocabulary (C-19).** This feature contributes the closure fields and the
monotone / antitone-only properties above; which operators are admissible on them, and the
publish-time rejection of a rule using one outside a field's domain, live in 002's operator table and
nowhere else. An existential over a closure is satisfied *by* adding an edge, which is why it has no
admissible operator there — a second vocabulary here would be a second authority to disagree with.

**Rationale**: C-03 states the asymmetry; a runtime check that enforces it is a check someone can
route around with a new query method at 3am, and the routing-around is invisible because the
narrower answer looks more precise. Expressing it as a type means the unsafe call does not compile.

**Alternatives**: a provenance threshold (C-03 explicitly rejects it — a single number treats
widening and narrowing as equally costly when one costs review time and the other costs a permitted
action that should have been blocked); a runtime assertion in the policy engine (enforces the rule
at exactly one call site, and every new consumer is a new omission).

## R-06 · Uncertainty enters risk as a penalty, never as a score

**Decision**: `ImpactClosure` exposes `weakestConfidence` and `crossedUnconfirmed` to the risk
computation as an **uncertainty penalty** — a non-negative addend to the risk classification — never
as a confidence multiplier or a quality score.

**Rationale**: a value called "confidence" invites `risk = base * confidence`, which lowers risk when
the graph is unsure. That is the exact inversion C-03 forbids, and it reads as reasonable in review.
A field whose only permitted use is addition to a risk floor cannot be used that way. The penalty is
monotone in uncertainty: a weaker path produces an equal or higher classification, never a lower one.

## R-07 · A draft is stored as a diff, so it is presented as one

**Decision**: `draft_item` rows carry an operation — `add_node`, `add_edge`, `modify_attributes`,
`mark_removed` — against confirmed state at the graph version the run started from. Discovery never
stores a candidate graph; it stores the difference between what it inferred and what is confirmed.

**Rationale**: the spec requires re-discovery of a confirmed graph to be presented as a diff, and a
requirement that lives in the rendering layer is a requirement one new UI can drop. Storing the diff
also makes the first run a special case of nothing: against an empty confirmed graph every item is
an `add_*`, so there is one code path rather than "initial discovery" and "re-discovery".

A run whose base version is no longer current is rebased against the current confirmed state before
review, and items whose target changed since the run started are marked `superseded` rather than
applied — a confirmation must not be a decision about stale state.

## R-08 · The proposal digest excludes confidence

**Decision**: a rejected proposal is remembered by a digest over its *structural* content — the
operation, the endpoint identities, the edge type, the layer and the normalised attribute set. The
digest deliberately excludes confidence, observation counts, recency and the discovery run
identifier.

**Rationale**: FR-011 says a rejected proposal must not be re-raised unchanged. Trace-derived
confidence moves on every run, because observation volume moves. If confidence were in the digest,
every re-run would produce a different digest, every rejection would be forgotten, and the human
would re-reject the same four edges weekly until they stopped reviewing drafts at all — which is the
real failure, not the duplicate row.

The converse matters too: a genuinely different proposal must reappear. Because the digest covers
attributes, an edge re-proposed with a different type or a different endpoint is a new proposal and
is raised.

## R-09 · Confirmation is a capability, not a role check

**Decision**: confirmation, rejection, manual edit and drift resolution require an actor of type
`human` in the authenticated context **and** the `graph:confirm` capability, which is not present on
any agent or automation credential. No MCP tool (ADR 0005), no in-process command interface and no
job handler exposes a confirm path.

**Rationale**: the constitution's security model is that permissions are what tools grant, not what
prompts say. An `if (actor.type !== 'human') throw` inside a handler is a prompt-equivalent — it
protects the one handler that has it. Withholding the capability from the credential means an agent
that tried would fail at the boundary and produce an audit record of the attempt, which is also how
we find out it tried.

## R-10 · Cycles terminate and are recorded

**Decision**: the recursive term excludes nodes already on the path (`NOT to_node_id = ANY(path)`)
and enforces a depth ceiling. A truncated branch emits a row with `termination` of `cycle` or
`depth_limit` naming the repeated node.

**Rationale**: circular component dependencies are normal in real systems and must be traversable.
Terminating silently would understate the blast radius — a narrowing, which C-03 forbids — so the
truncation is a returned fact the consumer can widen on, not an internal detail.

## R-11 · Discovery adds four shapes to the boundary contract

**Decision**: discovery collectors run in the execution plane and transmit only
`component_candidate`, `deployment_unit_candidate`, `dependency_observation` and `repository_ref`,
each a closed Zod schema with no free-form string field. These are added to 012 FR-022's versioned
schema set in the same change; `graph-contract.md` holds their field lists and
`012/contracts/runner-protocol.md` is updated to match.

**Rationale**: 012's closed list has no shape for a graph fact. The tempting move is to send graph
facts inside `tool_output_summary`, whose structured fields are declared by the tool — which reopens
the free-form channel 012 R-04 closed, on the one path that also reads the customer's entire
repository layout. Declaring four shapes costs four schemas and keeps 003 SC-002's validation
meaningful.

Repository contents do not cross (FR-021): the code-layer adapter resolves symbols to components
inside the execution plane and transmits paths, module identifiers and edge facts, never file bodies.

## R-12 · Identity is minted, never derived from a path

**Decision**: every node has a minted UUID v7 identity plus a `natural_key` (repository path,
Kubernetes resource reference, trace service name) used only for matching across discovery runs. A
rename rewrites `natural_key` on the existing row and records a `renamed` graph change.

**Rationale**: if identity were the path, a directory move would delete a component and create a new
one, discarding its confirmation, its ownership, its drift history and every evidence reference
pointing at it. The edge case is explicit in the spec, and it is common — the design partner's
monorepo will be reorganised before the first year is out.

A `natural_key` that matches two components in different repositories is a collision, not a merge:
both persist and the collision is surfaced for the confirmation step (spec edge case).

## R-13 · An empty graph is an envelope, never a bare empty array

**Decision**: every graph read returns `{ graphVersion, confirmationState, coverage, items }` where
`confirmationState` is one of `never_discovered`, `unconfirmed`, `partially_confirmed`, `confirmed`.
There is no endpoint that returns a bare list of components.

**Rationale**: the spec's last edge case is a consumer treating emptiness as "no dependencies", which
is the narrowing error again in its cheapest form. An envelope makes the distinction between "no
dependency" and "the graph does not know" (FR-016) a field rather than an inference, and makes
explicit degradation (003-style) the default behaviour of any consumer that reads the response at
all.

## R-14 · Drift raises an `Issue`; it does not own a lifecycle

**Decision**: a `drift_finding` row holds the two sides and their evidence references, and raising
it creates an `Issue` of kind `knowledge_drift` (001 FR-001), which terminates at human adjudication
and never enters reproduction or change (001 FR-001a). Resolution transitions both, in one audited
transaction.

**Rationale**: a second lifecycle with its own states, its own notifications and its own staleness
rules would drift from the issue lifecycle within a release, and a customer would have two inboxes.
005 raises knowledge drift the same way, so a human sees one queue of "the model of your system
disagrees with your system".

Graph staleness (FR-019) does not raise an issue: an unobserved component is flagged and surfaced in
the draft review surface, because an issue per quiet component would bury the real ones.

## R-15 · Confidence is an integer sum of named terms, capped

**Decision**: edge confidence is `min(100, provenance_base + observation_term − staleness_term)`,
clamped at 0, each term an integer. `provenance_base` is keyed on the **closed provenance set of
FR-005** and has one row per class — no other vocabulary exists:

| `provenance_base` | Class |
|-------------------|-------|
| 90 | `human_confirmed` |
| 85 | `human_authored` |
| 70 | `derived_from_trace` |
| 65 | `derived_from_runtime` |
| 60 | `derived_from_code` |
| 50 | `derived_from_config` |
| 20 | `inferred_from_convention` |

| Term | Value |
|------|-------|
| `observation_term` | `min(20, 4 × log2(1 + distinct observation days))` |
| `staleness_term` | `5 × complete 30-day periods since the last supporting observation`, capped at 40 |

The base ordering is the strength ordering of R-03 rescaled — the same claim about which sources
outrank which, so the two cannot disagree. The result is the `smallint` 0–100 written **once** at
insert time (data-model): it is never recomputed on a schedule, because a confidence that drifts with
wall-clock time cannot be reproduced by a pinned query (FR-014, SC-005). `staleness_term` is
therefore evaluated at write time against the observation window, not against today.

Integers and a fixed cap, for the same reason 003's ranking uses them: a float sum is not
byte-reproducible across platforms, and a confidence that differs between two machines makes a
policy decision non-deterministic.

**Rationale**: FR-016a only needs an ordering that is stable and explainable, not a calibrated
probability. Naming the terms means a number can be decomposed when someone asks why an edge scored
what it did. The constants are per-tenant configuration with these starting values, to be tuned once
discovery accuracy is measured (stage 0 S0-4).

**Alternatives**: a learned score (nothing to learn from yet, and it would be unexplainable at the
moment someone needs the explanation); a bare provenance ordinal (loses recency, so an edge observed
once two years ago outranks one derived from today's AST).

## R-16 · The draft review surface belongs to the dashboard, not here

**Decision**: this feature contracts `GET /discovery/drafts/{id}` and the confirm and reject
operations. The human review screen is a dashboard concern (012 `apps/dashboard`). SC-006a's measured
review session is run against the dashboard.

**Rationale**: every feature that produces a draft — 004, 005, 009, 011 — would otherwise each
specify a review screen, and four review screens is four products. The API is here; the surface is
one place.

## Unresolved

None.
