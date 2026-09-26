# Implementation Plan: System model and architecture discovery

**Branch**: `004-architecture-graph` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

One architecture-agnostic model — `Component`, `DeploymentUnit`, `Repository`, plus the code,
runtime and product layers over them — built by discovery that proposes and never asserts, and
queried in a way that cannot produce a dangerous answer.

Three commitments shape the design. **Everything is a node and an edge in two tables**, so a
blast-radius traversal is one recursive CTE rather than a union over five relationship tables
(ADR 0004). **The weakest edge on a path is computed by the traversal itself**, with `LEAST` in the
recursive step, so uncertainty cannot be lost between the query and the consumer. And **C-03 is
enforced by types, not by a check**: the closure a policy predicate can read is the one that
includes every edge regardless of confidence, so an unconfirmed edge can only add members, and the
filtered, narrower result has a different type that no predicate accepts. The unsafe direction is
not a rule someone can forget — there is no function that returns it to a place where it would do
harm.

Discovery is presumed wrong until a human confirms it, and that includes the tenth run against an
already-confirmed graph: a draft is stored as a set of diff operations against confirmed state, so
"present it as a diff" is the storage shape rather than a rendering concern.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`), Prisma 6 (multi-schema), BullMQ, Zod
(discovery evidence shapes), ts-morph (code-layer adapter, shared with 008), Pino, OpenTelemetry

**Storage**: PostgreSQL 17, schema `architecture`. Traversal by recursive CTE; no graph database
(ADR 0004, D-05). Graph versions are validity ranges on rows, not snapshots

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12); three architecture
fixtures — monolith, microservices, serverless — driving one query set (SC-008)

**Target Platform**: model and query layer in the control plane; discovery collectors in the
customer's execution plane behind the runner contract (ADR 0001, 003 FR-002)

**Project Type**: domain package `packages/domain/architecture`, adapters in
`packages/integrations/*`

**Performance Goals**: blast radius to depth 6 under 150 ms p95 on a graph of 5 000 nodes and
50 000 edges; a full discovery run over the design partner's monorepo under 20 minutes; a pinned
historical query no slower than a current one

**Constraints**: no node or edge without provenance, strength and confidence; no automatic write to
confirmed state; no repository content crossing the plane boundary in bulk (FR-021)

**Scale/Scope**: hundreds of components per tenant, thousands of edges, a graph version per
confirmation — thousands of versions over a year, all queryable

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every derived node and edge resolves to an `Evidence` record (001 FR-007); an element with no provenance is rejected by a database constraint, not by a service | ✅ |
| II. Anti-Circular Verification | The product layer cannot be confirmed by inference (FR-013); `feature → endpoint` is a human seam, which is what keeps 008's anchors independent | ✅ |
| III. Reproduce Before Modify | Not exercised here | n/a |
| IV. Deterministic Control | Traversal, weakest-edge confidence and strength ordering are SQL over stored ordinals. No model participates in building or querying the graph | ✅ |
| V. Dependency-Aware Change | This feature *is* the impact graph 008 FR-001 scopes a change by | ✅ |
| VI. Serialize / Parallelize | Discovery collectors run in parallel per source; confirmation is a serialised transaction that mints one graph version | ✅ |
| VII. Architecture Agnostic | `Component` + narrow type + open `characteristics`; `DeploymentUnit` separate; `Component` ↔ `Repository` many-to-many. Architecture-conditional code exists only in adapters, enforced by a gate (SC-008) | ✅ |
| VIII. Simplicity | Two tables and one recursive CTE instead of a graph database; validity ranges instead of version snapshots | ✅ |

**Tenancy**: `tenant_id` on every table, leading every index, in every query (012 FR-048). A
foreign graph element returns not-found (FR-024).

**Untrusted input**: repository paths, commit messages, configuration keys, Kubernetes annotations
and trace attributes are discovery *input* and never reach a policy predicate or a tool selection
(FR-026, 003 FR-021).

## Project Structure

### Documentation (this feature)

```text
specs/004-architecture-graph/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml        # graph reads, drafts, confirmation, drift
    └── graph-contract.md   # in-process query surface, strength ordering,
                            # discovery boundary shapes, adapter interface, events
```

### Source code

```text
packages/domain/architecture/
├── domain/           # Component, DeploymentUnit, Repository, GraphEdge, provenance ordering,
│                     # DiscoveryDraft, DriftFinding
├── application/
│   ├── commands/     # RunDiscovery, ConfirmDraftItems, RejectDraftItems, EditGraphElement,
│   │                 # ResolveDrift, RecordObservedDependency
│   └── queries/      # GetSystemContext, GetComponent, ImpactClosure, KnownSubgraph,
│                     # GetDraftDiff, ListDrift
├── infrastructure/   # Prisma repositories, the recursive-CTE traversal, version minting
└── presentation/     # controllers, DTOs, the read envelope

packages/integrations/
├── gitlab/           # repository and code-layer discovery
├── kubernetes/       # deployment-unit discovery
└── otel/             # trace-derived dependency observations
```

**Structure decision**: the traversal lives in `infrastructure/` as SQL, not as an application-layer
graph walk in TypeScript. A walk in application code would load the edge set into memory, lose the
tenant predicate from the query layer to a filter, and make the weakest-edge rule a loop someone can
get wrong. Adapters are separate packages because SC-008 requires a structural check that no
architecture-conditional branch exists outside them — a check that is only possible if "outside
them" is a path pattern (012 FR-002).

## Phase 0 — research

See [research.md](research.md): the two-table shape and why traversal is one CTE, weakest-edge
confidence in the recursive step, the stored strength ordering and its relationship to the
constitution's trust hierarchy, graph versioning by validity range, how C-03 is made inexpressible,
proposal digests that survive re-discovery, cycle termination, and the four boundary shapes
discovery adds to 012's closed list.

## Phase 1 — design

- [data-model.md](data-model.md) — `graph_node`, `graph_edge`, the kind attribute tables,
  `edge_provenance`, `graph_version`, `discovery_run`, `discovery_draft`, `draft_item`,
  `proposal_rejection`, `drift_finding`. Issues, evidence and audit belong to 001.
- [contracts/openapi.yaml](contracts/openapi.yaml) — graph reads, draft review, confirmation.
- [contracts/graph-contract.md](contracts/graph-contract.md) — the in-process surface 002, 006 and
  008 program against, and the runner-side discovery shapes.
- [quickstart.md](quickstart.md) — scenarios, including the ones that must fail.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| One `graph_node` supertype table with kind attribute tables beside it | Blast radius must be one recursive CTE; five endpoint-typed edge tables make it a union that the planner cannot index well | Separate tables per entity read better and traverse worse, and traversal is the query that decides whether a change is safe |
| Two result types for traversal (`ImpactClosure`, `KnownSubgraph`) | C-03 must be unexpressible rather than checked | One result type with a strength filter puts the dangerous call one argument away from any caller under deadline |
| Graph versions as validity ranges rather than snapshots | A version is minted on every confirmation; snapshots would multiply the graph by the number of confirmations | A snapshot table is simpler to reason about and unaffordable at one row set per confirmation |
| Provenance strength stored as an ordinal column, not derived at read time | A query pinned at an old version must reproduce the ordering that existed then | Deriving from the provenance enum makes every historical result change the day the ordering is tuned |
| Four new shapes on the runner boundary contract (012 FR-022) | Discovery transmits graph facts, and 012's closed list has no shape for one | Reusing `tool_output_summary` for graph facts turns a closed schema into a free-form channel — exactly what 012 R-04 closed |
