# Feature Specification: System model and architecture discovery

**Feature Branch**: `004-architecture-graph`

**Created**: 2026-09-23

**Status**: Draft

**Input**: One architecture-agnostic model of a customer's system — `Component`, `DeploymentUnit`, `Repository` and the code, runtime and product graphs that link them — built by discovery that infers from incomplete sources, carries provenance and confidence on every edge, and produces a draft the customer confirms rather than an assertion the system believes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discovery is the front door, and it produces a draft (Priority: P1)

A new customer connects a repository, a runtime and an observability stack. Within the hour they
are looking at a proposed map of their own system: components, what depends on what, which
deployment units run which code, which endpoints exist. Each item says where it came from. They
correct four things, confirm the rest, and the graph becomes real. Nothing was asserted at them as
fact.

**Why this priority**: this is the first thing every customer touches and the thing every later
capability reads. Discovery is inference from incomplete sources and will never be fully correct —
a product that presents inference as fact loses the customer's trust in the first hour, before it
has produced any value to offset the loss.

**Independent Test**: point discovery at the design partner's monorepo and runtime → a draft graph
exists containing components, deployment units and dependencies, every element unconfirmed, nothing
written to the active graph until a human confirms it.

**Acceptance Scenarios**:

1. **Given** connected sources, **When** discovery runs, **Then** it produces a `DiscoveryDraft`
   whose elements are all in state `proposed`, and the active graph is unchanged.
2. **Given** a draft, **When** a human reviews it, **Then** each proposed element shows its
   provenance, its confidence and the specific observation that produced it.
3. **Given** a human rejects a proposed component, **When** discovery is re-run later, **Then** the
   rejection is honoured and the same proposal is not re-raised unchanged.
4. **Given** a human confirms an element, **When** a later discovery run infers something
   contradicting it, **Then** the confirmed element is not overwritten; the contradiction is raised
   for a human.
5. **Given** discovery has never been confirmed for a tenant, **When** a consumer queries the
   graph, **Then** it receives the unconfirmed graph explicitly labelled as such, never as fact.

---

### User Story 2 - Every edge says where it came from and how sure it is (Priority: P1)

An engineer asks why Healer believes the worker depends on the payments component. The answer is
"observed in 4 212 distributed traces over the last 7 days", not "it looked like it". Another edge
says "inferred from directory layout" and is visibly weaker.

**Why this priority**: a graph without provenance is a wiki with better formatting. Provenance is
what lets a consumer refuse a weak edge, what lets a human review a draft in minutes instead of
hours, and what makes an eventual wrong answer explainable rather than mysterious.

**Independent Test**: for every node and edge in a discovered graph, provenance and confidence
resolve to a specific observation or a named human; an element with neither cannot be persisted.

**Acceptance Scenarios**:

1. **Given** any node or edge, **When** it is read, **Then** it carries a provenance class, a
   confidence level, a source reference and the discovery run that produced it.
2. **Given** an edge derived from distributed traces and an edge inferred from folder names,
   **When** they are ranked, **Then** the trace-derived edge ranks above the inferred one by a
   deterministic, documented ordering.
3. **Given** two sources produce the same edge, **When** the graph is built, **Then** the edge
   records both provenances and takes the confidence of the strongest, and both remain inspectable.
4. **Given** an element with no provenance, **When** persistence is attempted, **Then** it is
   rejected.

---

### User Story 3 - One model for any architecture (Priority: P1)

The design partner runs a monorepo with a backend, a frontend and a worker. A later customer runs
forty microservices. A third runs a ten-year-old monolith with two serverless functions bolted on.
All three are the same entities with different edges. No agent contains a branch on architecture
style.

**Why this priority**: Principle VII and D-03. Modelling `Service` instead of `Component`, or
architecture as an enum, forces a rewrite the first time a customer is hybrid — and every real
customer is hybrid. Supporting a new architecture must be a new adapter, never new agents.

**Independent Test**: load a monolith fixture, a microservice fixture and a serverless fixture into
the same model → all three populate the same entities and satisfy the same queries, with no
architecture-conditional logic outside the adapters.

**Acceptance Scenarios**:

1. **Given** any supported system shape, **When** it is modelled, **Then** it uses `Component` with
   a narrow `ComponentType` plus a set of `characteristics`, and no single enum describes the
   system's architecture (D-09).
2. **Given** a monorepo containing three components, **When** repositories are linked, **Then**
   three components map to one repository; **and given** a component built from two repositories,
   **Then** that is representable too.
3. **Given** a logical component deployed as two deployment units in two environments, **When** the
   graph is read, **Then** `Component` and `DeploymentUnit` are distinct entities with an explicit
   relationship, not one entity with an environment field.
4. **Given** an agent requests context, **When** it receives `SystemContext`, **Then** the payload
   contains no architecture-style discriminator and the agent's behaviour does not branch on one.

---

### User Story 4 - Blast radius, with its uncertainty attached (Priority: P2)

Impact analysis asks the graph what a change to a shared module touches. The answer is a set of
components and deployment units — each with the confidence of the weakest edge on the path that
produced it. A path that ran through a guessed edge is visibly weaker than one that ran through a
trace.

**Why this priority**: this is where a wrong graph becomes a wrong outcome. Wrong graph → wrong
blast radius → wrong impact classification → a policy decision taken on false structural facts →
a confidently bad change. The uncertainty must travel with the answer or the failure is silent.

**Independent Test**: seed a graph with a deliberately weak edge → every dependency query whose
path crosses it returns a reduced confidence and names the weak edge.

**Acceptance Scenarios**:

1. **Given** a dependency or blast-radius query, **When** it returns, **Then** each result carries
   the path that produced it and a confidence derived from the weakest edge on that path.
2. **Given** a result whose path includes an unconfirmed edge, **When** a consumer evaluates it,
   **Then** the unconfirmed status is machine-readable so the consumer may refuse it.
3. **Given** a query at a recorded graph version, **When** it is re-run at that version, **Then**
   the result is identical, regardless of later graph changes.
4. **Given** a component that discovery never resolved, **When** it appears in an impact query,
   **Then** it is returned as unresolved rather than omitted.

---

### User Story 5 - The graph rots, and drift is an issue for a human (Priority: P2)

Three months in, traces show a call from the frontend directly to the payments component that the
graph says cannot exist. Healer does not quietly add the edge and does not quietly ignore it. It
raises drift, with both observations attached, for a person to judge.

**Why this priority**: every architecture document in every company is wrong, and this one will be
too. The difference between a useful graph and a wiki is that this one notices, and the difference
between a safe product and a dangerous one is that it does not resolve the disagreement by itself.

**Independent Test**: introduce an observed dependency contradicting a confirmed edge → a drift
finding exists within the detection window, routed to a human, with the graph unchanged.

**Acceptance Scenarios**:

1. **Given** observed reality contradicts a confirmed graph element, **When** drift detection runs,
   **Then** a drift finding is raised carrying both the confirmed claim and the observation.
2. **Given** a drift finding, **When** it exists, **Then** the graph is not modified automatically
   in either direction.
3. **Given** a component with no observation within its staleness window, **When** staleness is
   evaluated, **Then** it is flagged as possibly removed and surfaced, never deleted automatically.
4. **Given** a drift finding is resolved by a human, **When** the resolution is recorded, **Then**
   the graph change, the actor and the finding are linked in the audit trail.

---

### User Story 6 - The product graph is human, and it is the small seam (Priority: P3)

Features, user flows and expected behaviour are not in the code, because the code may be wrong.
Healer proposes `feature → endpoint` links from OpenAPI descriptions and end-to-end test names, and
a human confirms them. That confirmation is the one manual seam in the whole linking chain.

**Why this priority**: product knowledge is what everything distinctive depends on, and it is the
only layer that cannot be derived. Keeping the manual seam to one small, well-defined link is what
makes onboarding survivable.

**Independent Test**: seed feature-to-endpoint proposals for one design-partner feature → all are
`proposed` until confirmed, and no proposal can enter the product layer as confirmed automatically.

**Acceptance Scenarios**:

1. **Given** a proposed `feature → endpoint` link, **When** it is persisted, **Then** it is in state
   `proposed` and its provenance is machine-generated.
2. **Given** a product-layer element, **When** confirmation is attempted by a non-human actor,
   **Then** it is refused.
3. **Given** a confirmed feature link, **When** the endpoint it names disappears from the code and
   runtime graphs, **Then** drift is raised against the product layer.

---

### Edge Cases

- A component exists in code but never appears in traces (dead code, or a feature nobody uses) →
  it is retained with its code-layer provenance and marked unobserved, never deleted on absence.
- A deployment unit appears in runtime with no matching code component (a third-party sidecar) →
  modelled as an external component, not force-fitted to a repository.
- A repository is renamed or split → identity is carried by a stable component identifier, not by
  path; the rename is recorded as a graph change, not as a delete plus create.
- Circular dependencies between components → representable and traversable; blast-radius queries
  terminate with a recorded cycle rather than looping.
- Discovery is run against a repository it cannot fully parse → partial results are kept with the
  unparsed portion recorded, mirroring 003 FR-014's per-source outcome model.
- Two components share a name in different repositories → both persist; disambiguation is part of
  the confirmation step, and an unresolved name collision is surfaced rather than merged.
- A trace-derived edge appears once, from a single request → confidence reflects observation volume
  and recency; a single observation is an observation, not a fact.
- The customer confirms a graph and then reorganises their system entirely → re-discovery proposes
  a large diff; the review surface must present it as a diff against confirmed state, not as a new
  graph replacing the old one.
- A consumer queries the graph before any discovery has run → an empty graph labelled unconfirmed
  is returned, and consumers degrade explicitly rather than treating emptiness as "no dependencies".

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST model `Component` as the unit of the system, with a narrow
  `ComponentType` and an open set of `characteristics`. No field MUST describe a system's
  architecture as a single enumerated style (D-09).
- **FR-002**: System MUST model `DeploymentUnit` as an entity distinct from `Component`, with an
  explicit relationship between them, and MUST support one component mapping to many deployment
  units across environments.
- **FR-003**: `Component` ↔ `Repository` MUST be many-to-many, supporting both a monorepo
  containing many components and a component assembled from many repositories.
- **FR-004**: System MUST represent three graph layers — code, runtime and product — over one set
  of entities, with every node and edge carrying its layer.
- **FR-005**: Every node and every edge MUST carry a provenance class from a closed set:
  `human_authored`, `human_confirmed`, `derived_from_trace`, `derived_from_runtime`,
  `derived_from_code`, `derived_from_config`, `inferred_from_convention`. Persistence without a
  provenance class MUST be rejected.
- **FR-006**: Every node and every edge MUST carry a confidence value and a reference to the
  observation or actor that produced it, resolvable to an `Evidence` record (001 FR-007) where it
  came from an observation.
- **FR-007**: Provenance MUST impose a deterministic strength ordering in which observed sources
  outrank inferred ones — `human_confirmed` and `derived_from_trace` above `derived_from_runtime`
  and `derived_from_code`, and all of those above `inferred_from_convention`.
- **FR-008**: When multiple sources produce the same element, the system MUST retain every
  provenance and take the confidence of the strongest, keeping each contributing observation
  inspectable.
- **FR-009**: Discovery MUST produce a `DiscoveryDraft` whose elements are in state `proposed`.
  Discovery MUST NOT write to the active graph without an explicit human confirmation action.
- **FR-010**: Confirmation and rejection MUST be performable only by a human actor, MUST record the
  actor and timestamp, and MUST be audited (001 FR-012). An agent or automation credential MUST NOT
  be able to confirm a graph element.
- **FR-011**: A rejected proposal MUST NOT be re-raised unchanged by a subsequent discovery run.
- **FR-012**: A subsequent discovery run MUST NOT overwrite a human-confirmed element. A
  contradiction between inference and a confirmed element MUST be raised as drift (FR-017).
- **FR-013**: Product-layer elements — features, flows and `feature → endpoint` links — MUST NOT be
  created in a confirmed state by inference. They MUST be seeded as proposals and require human
  confirmation.
- **FR-014**: The graph MUST be versioned. Every query MUST resolve against a graph version, and
  re-running a query at a recorded version MUST produce an identical result.
- **FR-015**: Dependency and blast-radius queries MUST return, for every result, the path that
  produced it and a confidence derived from the weakest edge on that path, with unconfirmed edges
  identified in machine-readable form.
- **FR-016**: A consumer MUST be able to constrain a query to elements at or above a given
  provenance strength or confidence, and MUST be able to distinguish "no dependency" from "graph
  does not know".
- **FR-016a**: An unconfirmed edge MUST affect an impact classification **asymmetrically**: it MAY
  widen the blast radius and MAY raise the resulting risk, and it MUST NOT narrow a blast radius,
  lower a risk classification, or satisfy a condition that permits an action. A provenance threshold
  is therefore not required — being wrong about an unconfirmed edge can only cost additional human
  review, never a permitted action that should have been blocked.
- **FR-017**: System MUST detect drift between the graph and observed reality — an observed
  dependency absent from the graph, a graph element contradicted by observation, a deployment unit
  no longer present — and MUST raise a finding routed to a human.
- **FR-018**: A drift finding MUST NOT modify the graph automatically in either direction, and MUST
  carry both the recorded claim and the contradicting observation with their evidence references.
- **FR-019**: Elements unobserved beyond a configured staleness window MUST be flagged and
  surfaced, and MUST NOT be deleted automatically.
- **FR-020**: Architecture-specific logic MUST exist only in adapters and discovery. `SystemContext`
  delivered to an agent MUST NOT carry an architecture-style discriminator, and agent behaviour MUST
  NOT branch on one.
- **FR-021**: Discovery collection MUST run in the customer's execution plane and MUST transmit only
  the four graph shapes declared in [`contracts/graph-contract.md`](contracts/graph-contract.md) §3 —
  `component_candidate`, `deployment_unit_candidate`, `dependency_observation`, `repository_ref` — as
  members of the closed crossing list of 012
  [`contracts/runner-protocol.md`](../012-engineering-foundation/contracts/runner-protocol.md), which
  is the authority for what may cross. Repository contents MUST NOT cross in bulk to build the graph.
- **FR-022**: Discovery MUST be read-only against every customer system it inspects.
- **FR-023**: Discovery MUST tolerate partial and unavailable sources, recording per-source outcomes
  in the same form as 003 FR-014, and MUST produce a draft from whatever was available.
- **FR-024**: Every component, deployment unit, repository, edge, draft and drift finding MUST carry
  `tenantId`, and every graph read MUST be constrained by the `tenantId` from the authenticated
  context (001 FR-015). A request for another tenant's graph element MUST return not-found, never
  forbidden.
- **FR-025**: Every graph mutation — confirmation, rejection, manual edit, drift resolution — MUST
  be recorded as an audited change with actor, before and after state, and reason (001 FR-012).
- **FR-026**: Content read during discovery — repository file names, commit messages, configuration
  keys, annotations, trace attributes — MUST be treated as data and MUST NOT influence which
  sources are inspected, any policy predicate (002 FR-003) or any tool invocation.
- **FR-027**: Every discovery fact received from the execution plane MUST be persisted by the
  discovery step as an `Evidence` record of type `graph_fact` (001 FR-007), emitted by that step
  (001 FR-008). Each of the four transmitted shapes maps to exactly one `graph_fact` record, and the
  `observation_ref` of every node, edge, `edge_provenance` row and draft item derived from it MUST
  reference that record. A graph element whose provenance class is not human-authored or
  human-confirmed MUST NOT be persisted without such a reference (FR-006, SC-001).

### Key Entities

- **Component**: the logical unit of a system. Tenant, stable identifier, name, `ComponentType`,
  `characteristics`, owner reference, lifecycle state, provenance, confidence.
- **ComponentType**: a narrow classification (service, library, frontend, worker, job, datastore,
  external) that never attempts to describe the system's architecture.
- **Characteristic**: an orthogonal property of a component — stateful, user-facing, money path,
  public contract, scheduled, third-party — combinable without a fixed taxonomy of system styles.
- **DeploymentUnit**: a runnable artifact in an environment. Environment, runtime identity, current
  version, relationship to one or more components, provenance.
- **Repository**: a source repository, linked many-to-many with components, carrying its VCS
  reference and default branch.
- **GraphEdge**: a typed relationship (depends-on, calls, deploys, contains, implements, exposes,
  serves-feature, built-from) carrying layer, provenance, confidence, observation reference and state
  (`proposed` | `confirmed` | `rejected` | `stale`).
- **Feature** and **Flow**: product-layer entities, human-authored or human-confirmed only, linked
  to endpoints and components through the confirmed seam.
- **DiscoveryRun**: one execution of discovery — sources consulted, per-source outcomes, adapter
  versions, elements proposed, duration.
- **DiscoveryDraft**: the reviewable set of proposals from a run, presented as a diff against
  confirmed state.
- **GraphVersion**: an addressable version of the graph that a query, an evidence record or an
  impact analysis can pin.
- **DriftFinding**: a recorded disagreement between the graph and observation, with both sides, its
  evidence references, its state and its human resolution.
- **Adapter**: the architecture-specific code that reads one customer system class; the only place
  such logic exists.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 nodes or edges exist without a provenance class and a confidence value, verified by
  a continuous invariant check.
- **SC-002**: 0 product-layer `feature → endpoint` links reach a confirmed state without a
  confirmation record naming a human actor.
- **SC-003**: 0 human-confirmed elements are overwritten by a discovery run; every contradiction
  appears as a drift finding instead.
- **SC-004**: 100% of dependency and blast-radius results carry their derivation path and a
  confidence equal to the weakest edge on that path.
- **SC-005**: A query re-run at a pinned graph version returns identical results in 100% of cases,
  independent of later graph changes.
- **SC-006**: Discovery against the design partner's monorepo **recalls at least 90%** of the
  components a human baseline lists, every missed one named in the run report; on a baseline of fewer
  than ten components the tolerance is exactly one miss. Components discovery proposes that the
  baseline omits are reported separately and are not counted as misses — the baseline is a human's
  list, not ground truth.
- **SC-006a**: The first draft review is **measured with no pass threshold in v1**: proposals raised,
  the share of them accepted without edit, and review wall-clock seconds are recorded on
  `discovery_draft` as the onboarding baseline. These numbers are what a later release's threshold is
  derived from (stage 0, S0-4); there is nothing here to pass or fail yet.
- **SC-007**: A dependency observed in production but absent from the graph produces a drift finding
  within the configured detection window in 100% of seeded cases, with 0 automatic graph edits.
- **SC-008**: Monolith, microservice and serverless fixtures populate the same entities and satisfy
  the same query set, with 0 architecture-conditional branches outside adapter code, verified by a
  structural check.
- **SC-009**: 0 cross-tenant graph elements are readable across an isolation matrix covering every
  graph query and every discovery endpoint.
- **SC-010**: 0 repository contents cross the plane boundary in bulk during discovery, verified by
  the same boundary-contract validation as 003 SC-002.

## Assumptions

- This specification owns the system model, the three graph layers, discovery, confirmation,
  provenance, confidence and drift of the graph. It does **not** own knowledge documents,
  `ExpectedBehavior` or knowledge drift (005), evidence collection and the boundary contract itself
  (003), impact analysis of a proposed change (008), or the `Evidence` model (001).
- v1 ships one adapter set (D-03, D-18, S0-4): a GitLab monorepo with backend, frontend and worker
  components, Kubernetes runtime, OpenTelemetry traces and the design partner's deploy mechanism.
  The model is general from day one; the adapters are not.
- Discovery is presumed wrong until confirmed. Its output is a draft in every case, including
  re-discovery of an already-confirmed graph, where it is presented as a diff.
- A graph drift finding is raised as an `Issue` of kind `knowledge_drift` (001 FR-001, FR-001a),
  which terminates at human adjudication rather than entering the diagnosis or change path.
- Confidence is a graded value derived from provenance, observation volume and recency. Its scale
  and the thresholds consumers apply are configuration, expected to be tuned once discovery accuracy
  is measured against the design partner's system.
- A customer may operate with an unconfirmed or partial graph. Consumers degrade explicitly — an
  unconfirmed graph weakens a conclusion rather than blocking the product — and this specification
  provides the machine-readable signal they degrade on.
- Component ownership references an identity provided by the customer's systems; this specification
  stores the reference and does not define the identity model.
