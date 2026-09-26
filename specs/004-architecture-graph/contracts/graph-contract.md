# Contract: the architecture graph

Three surfaces in one document, because they are three views of the same guarantee: the in-process
query surface that 002, 006 and 008 program against, the strength ordering everything ranks by, and
the boundary shapes discovery is allowed to transmit.

## 1 · The query surface (C-03)

Internal callers use typed in-process interfaces, not MCP (ADR 0005, D-06). Two traversal results
exist and **nothing converts between them**.

```ts
/** Upper bound. Traverses every edge in scope regardless of state, provenance or confidence.
 *  There is no strength or confidence parameter — narrowing is not expressible. */
interface ImpactClosure {
  readonly graphVersion: number;
  readonly root: NodeId;
  readonly members: ReadonlyArray<{
    nodeId: NodeId;
    nodeKind: NodeKind;
    path: ReadonlyArray<NodeId>;
    weakestConfidence: number;    // integer 0–100, LEAST over the path (R-02, R-15)
    weakestStrength: number;      // stored provenance ordinal (R-03)
    crossedUnconfirmed: boolean;  // machine-readable, FR-015
    termination?: 'cycle' | 'depth_limit';
    lifecycleState: 'active' | 'unobserved' | 'unresolved' | 'possibly_removed';
  }>;
  readonly truncated: boolean;
}

/** Filtered view for explanation and display (FR-016). Accepted by no predicate. */
interface KnownSubgraph {
  readonly resultKind: 'known_subgraph';   // the brand — see below
  readonly members: /* same member shape, filtered by minStrength / minConfidence */ unknown;
  readonly truncated: boolean;
}
```

### Precedent liveness (consumed by 006, C-22)

006 answers "does this component or concept still exist" from the reads already declared here, at a
pinned `graphVersion` — no new endpoint and no code-intelligence call:

| Outcome for 006 | How this contract answers it |
|-----------------|------------------------------|
| `absent` | The node is not present at the pinned version, and `confirmationState` says the graph **does** know that region |
| `moved` | The node is present but its containing component differs, or `lifecycleState` is `possibly_removed` |
| `unknown` | `confirmationState` says the graph does not know that region — a never-discovered graph must not read as `absent` |

The third row is the important one. A bare boolean `false` from an empty graph would read as `absent`
and zero a precedent's weight on no information at all, so every liveness read returns the envelope
rather than a boolean.

### The brand is load-bearing, not decoration

TypeScript is **structurally typed**. Two interfaces with the same members are mutually assignable,
so "accepted by no predicate" would have been a comment rather than a rule: a `KnownSubgraph` would
satisfy every `ImpactClosure` parameter and C-03's narrowing path would be wide open in-process.

Therefore:

- `ImpactClosure` carries `readonly resultKind: 'impact_closure'` and `KnownSubgraph` carries
  `readonly resultKind: 'known_subgraph'`. The discriminant makes them nominally distinct.
- The same discriminator appears in the **HTTP response schema**, so the narrowing path is closed
  over the wire too — a caller cannot hand a filtered response to an endpoint expecting a closure.
- Neither type has a constructor reachable outside `packages/domain/architecture`; both are produced
  by named query functions only.
- The conformance test asserts on the brand, not on shape: passing a `KnownSubgraph` where an
  `ImpactClosure` is required must fail to compile.

A structural "same members" comment is how this guarantee quietly becomes documentation.

| Caller | Receives | Why |
|--------|----------|-----|
| Impact classification (008 FR-003) | `ImpactClosure` | risk from what the change touches, widened by doubt |
| Policy predicate input (002 FR-003) | `ImpactClosure` | a permission condition must get harder, never easier, as the graph grows |
| Approval request content (002 FR-015) | `ImpactClosure` | the human reviews the widest plausible radius |
| Diagnosis component resolution (006 FR-016) | `ImpactClosure` | |
| Review surface, explanations, dashboards | `KnownSubgraph` | "what do we actually know" is a display question |

### The closure fields this contract contributes to the predicate vocabulary

**002 owns the predicate vocabulary, including the closure-shaped predicates (C-19).** The operators
admissible on each field and the publish-time validation that rejects a rule using one outside its
field's domain are in
[002 `contracts/evaluation.md` § Operator domains](../../002-policy-and-autonomy/contracts/evaluation.md).
This contract does not restate that table, and no operator list lives here.

What 004 contributes is the **fields** and the property of the type that makes them safe:

| Field contributed to `DecisionInput` | Derived from the closure as |
|--------------------------------------|-----------------------------|
| the closure's characteristic, component-type and environment sets | membership sets over `members` |
| the closure's member identifier set | `members[].nodeId` |
| the closure's size | `members.length` |
| the closure's maximum depth | `max(members[].path.length)` |

`ImpactClosure` is **monotone in the edge set** by construction: it takes no filtering parameter, so
adding an edge can only add members. Every quantity above is therefore either monotone in the edge
set (size, depth) or **antitone-only** in the satisfaction of a condition over it — "touches nothing
of class X" and "stays within the allowlist" can only become harder to satisfy as the graph grows.
These are stated facts about the type, on which 002's operator domains for these fields depend; they
are not a second vocabulary.

An existential over a closure ("contains component X") is satisfied *by adding an edge*, so an
unconfirmed edge would permit an action — the direction C-03 forbids. Keeping such a form out of the
permission path is 002's to enforce at publish time, on the operator domains of the fields above.

### Uncertainty in risk (R-06)

```text
riskClass = max(baseRiskFromTouchedCharacteristics, uncertaintyPenalty(closure))
```

`uncertaintyPenalty` is non-negative and monotone in uncertainty. There is no API returning a
confidence multiplier, because `risk * confidence` lowers risk when the graph is unsure and reads
as reasonable in review.

### Read envelope (R-13)

Every read — HTTP or in-process — returns:

```text
graphVersion         int
confirmationState    never_discovered | unconfirmed | partially_confirmed | confirmed
coverage             { nodesConfirmed, nodesTotal, edgesConfirmed, edgesTotal }
items                …
```

No endpoint returns a bare array. A consumer that reads the response at all can tell "no dependency"
from "the graph does not know" (FR-016), and emptiness is never mistakable for safety.

## 2 · Provenance strength ordering

Deterministic, stored per element as an ordinal at write time (FR-007, R-03). The mapping is
versioned; a query pinned at an old graph version reproduces the ordering that existed then.

| Ordinal | Class | Typical source |
|---------|-------|----------------|
| 70 | `human_confirmed` | a named human accepted a proposal |
| 65 | `human_authored` | a named human asserted it directly |
| 50 | `derived_from_trace` | OpenTelemetry spans — observed, not inferred |
| 40 | `derived_from_runtime` | Kubernetes resources, deploy records |
| 30 | `derived_from_code` | AST, imports, type graph (ts-morph) |
| 20 | `derived_from_config` | manifests, CI configuration |
| 10 | `inferred_from_convention` | folder layout, naming, ownership files |

When several sources produce the same edge, every provenance is retained in `edge_provenance` and
the edge takes the strongest (FR-008).

## 3 · Discovery across the plane boundary

Discovery collectors run in the execution plane (FR-021, FR-022, 003 FR-002) and are **read-only**
against every customer system. Four shapes are added to the closed, versioned boundary schema set
(012 FR-022); they are appended to `specs/012-engineering-foundation/contracts/runner-protocol.md`
in the same change. No free-form string field; anything not listed does not cross.

| Shape | Fields |
|-------|--------|
| `component_candidate` | `naturalKey`, `name`, `componentType`, `characteristics[]`, `ownerRef?`, `sourcePaths[]` (repository-relative paths, never contents), `adapterKey`, `adapterVersion` |
| `deployment_unit_candidate` | `naturalKey`, `environment`, `runtimeKind`, `runtimeRef`, `currentVersion`, `lastDeployedAt?` |
| `dependency_observation` | `fromNaturalKey`, `toNaturalKey`, `edgeType`, `layer`, `provenance`, `observationCount`, `firstObservedAt`, `lastObservedAt`, `windowSeconds` |
| `repository_ref` | `projectRef`, `defaultBranch`, `headSha`, `componentNaturalKeys[]` |

### Each shape becomes one `graph_fact` evidence record (FR-027)

001 declares `evidence.type = graph_fact` for this feature, and it is where every
`observation_ref` in the graph points. The discovery step — the step that received the shape, never a
later one (001 FR-008) — writes the record:

| Shape received | Persisted as | Referenced by |
|----------------|--------------|---------------|
| `component_candidate` | one `evidence` row, `type = graph_fact` | `graph_node.observation_ref` of the proposed component, and the `draft_item.observation_ref` that proposes it |
| `deployment_unit_candidate` | one `evidence` row, `type = graph_fact` | `graph_node.observation_ref` of the proposed deployment unit |
| `dependency_observation` | one `evidence` row, `type = graph_fact` | `edge_provenance.observation_ref` for that contributing observation, and through it the edge |
| `repository_ref` | one `evidence` row, `type = graph_fact` | `graph_node.observation_ref` of the repository node and of the `built_from` edges it supports |

The record carries the adapter key and version, the observation window and counts where the shape has
them, and the discovery run. This is what makes "where did this edge come from" answerable by a join
rather than by a discovery log, and it is why a non-human-provenance element with no
`observation_ref` cannot be persisted at all (FR-006, SC-001).

**Never crosses**: file contents, diff bodies, configuration values, environment variables, trace
attribute values, annotation values, log bodies. The code-layer adapter resolves symbols to
components *inside* the execution plane; only the resolved edge facts and paths come back.

An unparsable repository region produces a `collection_gap` (012 runner protocol) naming what was
skipped, and the draft is produced from the rest (FR-023).

### Adapter interface

The only place architecture-specific logic exists (FR-020, SC-008). Every adapter implements:

```ts
interface DiscoveryAdapter {
  readonly key: string;            // 'gitlab' | 'kubernetes' | 'otel'
  readonly version: string;        // recorded on every element it produces
  readonly layer: 'code' | 'runtime' | 'product';
  readonly provenance: ProvenanceClass;   // fixed per adapter — it cannot claim a stronger one
  collect(scope: DiscoveryScope): Promise<DiscoveryFacts>;   // read-only, bounded, cancellable
}
```

`provenance` is a constant of the adapter, not a value it chooses per element: an adapter that reads
folder names cannot emit `derived_from_trace` because it has no field in which to say so.

`SystemContext` handed to an agent contains components, deployment units, repositories,
characteristics and edges. It carries **no architecture-style discriminator** (FR-020), and a gate
(`gate-architecture-agnostic`, added to 012's gate set) fails the build on an architecture-
conditional branch outside `packages/integrations/**`.

## 4 · Events

Published through the transactional outbox (012 FR-031). Past tense means fact; a proposal is not a
fact.

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `DiscoveryDraftProposed` | a run produces a draft | `draftId`, `runId`, `baseVersion`, counts by op | dashboard |
| `GraphVersionPublished` | a confirmation, edit or drift resolution mints a version | `version`, `mintedBy`, `actorRef`, changed element counts | 006, 008, 011, dashboard |
| `GraphDriftDetected` | drift is raised | `findingId`, `kind`, `issueId`, `graphVersion` | 001, dashboard |
| `GraphElementStale` | an element passes its staleness window | `nodeId`, `lastObservedAt` | dashboard |

`GraphVersionPublished` is the signal a consumer holding a pinned version uses to decide whether to
re-query. Nothing is invalidated automatically: a pinned query keeps returning its pinned result
(FR-014, SC-005).

## 5 · What this contract forbids

- No caller receives a traversal narrowed by confidence in a path that can permit an action.
- No agent credential carries `graph:confirm`; no MCP tool exposes confirmation (R-09).
- No discovery run writes a confirmed element.
- No drift finding writes to the graph.
- No repository content crosses the boundary in bulk (FR-021, verified as 003 SC-002 is).
