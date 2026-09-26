# Feature Specification: Issue lifecycle and evidence substrate

**Feature Branch**: `001-issue-and-evidence`

**Created**: 2026-09-23

**Status**: Draft

**Input**: One `Issue` aggregate for every source — production incident, user report, monitoring alert, regression, automated detection — passing through one investigation pipeline, with an immutable evidence record behind every claim the system makes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One issue, not a thousand errors (Priority: P1)

A service starts failing. Twelve thousand error events arrive from three sources within four
minutes. The on-call engineer opens Healer and sees **one** issue with a count, a first-seen time,
the affected component and the sources that reported it — not a list to scroll.

**Why this priority**: without deduplication nothing else in the product is usable, and every
downstream cost (context collection, diagnosis, model calls) multiplies by the duplication factor.

**Independent Test**: replay a recorded burst of errors from two providers → exactly one issue
exists, with an accurate count and correct first/last seen times.

**Acceptance Scenarios**:

1. **Given** twelve thousand errors sharing a normalised signature, **When** they are ingested,
   **Then** one issue exists with `occurrenceCount = 12000`.
2. **Given** the same alert fires again after the issue was resolved, **When** it arrives inside
   the reopen window, **Then** the existing issue reopens rather than a new one being created.
3. **Given** the same alert fires again long after resolution, **When** it arrives outside the
   reopen window, **Then** a new issue is created and linked to the previous one as a recurrence.
4. **Given** an ingestion request is retried by the provider, **When** it carries the same delivery
   identifier, **Then** no duplicate events are recorded.

---

### User Story 2 - Every claim carries its evidence (Priority: P1)

An engineer reads a root-cause statement and asks "why do you think that?" Every element of the
answer — the log pattern, the correlated deploy, the trace, the failing test — is a record with a
source, a timestamp and a link back to the original system. Nothing is asserted without one.

**Why this priority**: this is Principle I. A claim without evidence is indistinguishable from a
confident hallucination, and the product's entire value rests on the difference.

**Independent Test**: for a seeded issue with a completed investigation, every displayed statement
resolves to at least one evidence record, and each record resolves to a retrievable source.

**Acceptance Scenarios**:

1. **Given** a diagnosis exists, **When** any conclusion is displayed, **Then** it carries ≥ 1
   evidence reference, and a conclusion without one cannot be persisted.
2. **Given** an evidence record was written, **When** anything attempts to modify it, **Then** the
   attempt is rejected — evidence is append-only.
3. **Given** the original source has been deleted or rotated away, **When** the evidence is
   displayed, **Then** it shows as `detached` with its captured summary, never as a broken link.
4. **Given** a step produced an evidence link, **When** the producing step is inspected, **Then**
   the link records which step emitted it and when.

---

### User Story 3 - One pipeline for every source (Priority: P1)

A user writes "I click Checkout and nothing happens." A monitoring alert fires on the same service.
Both become issues. Both pass through the same classification, context collection and evidence
building. What differs is only what happens after diagnosis.

**Why this priority**: the unified pipeline is what lets AutoSupport, self-healing and regression
detection share one engine instead of three. Splitting it later is a rewrite.

**Independent Test**: submit a user report and an alert describing the same underlying failure →
both reach diagnosis through identical steps and can be correlated to each other.

**Acceptance Scenarios**:

1. **Given** issues of different kinds, **When** they enter the pipeline, **Then** the stages
   executed are identical up to the decision point.
2. **Given** a user report and an alert share a component and time window, **When** correlation
   runs, **Then** they are linked as related issues without being merged.

---

### User Story 4 - The audit trail answers "why did you do that" (Priority: P2)

Weeks later, someone asks why Healer proposed a particular change. The record shows the actor, the
reason, the evidence, the model and prompt version, the tools called, the policy decision and the
outcome — enough to reconstruct the decision without rerunning it.

**Why this priority**: required for customer change-management review, and it is the same data as
the timeline and the evidence graph.

**Acceptance Scenarios**:

1. **Given** any agent action, **When** the audit record is read, **Then** it contains actor,
   action, reason, evidence references, model, prompt version, tools used, policy decision, outcome.
2. **Given** a prompt version referenced by an old record, **When** it is looked up, **Then** the
   exact version is retrievable.

---

### User Story 5 - Views over one dataset (Priority: P2)

**Three** views ship here — the timeline, the evidence graph and the audit trail (FR-013). They never
disagree, because they are queries over the same records rather than separate stores. The
constitution's "five views" also names the **postmortem draft** and **change correlation**; those are
two later surfaces over this same dataset, with no requirement, task or endpoint in this feature. They
are claimed as views, not delivered as views, and nothing here may be shaped as if they existed.

**Acceptance Scenarios**:

1. **Given** an issue with evidence, **When** the timeline and the evidence graph are rendered,
   **Then** they contain the same facts in different arrangements.
2. **Given** the timeline is requested, **When** it is produced, **Then** it is computed by query
   over structured records, with no model involved in ordering or selecting events.

---

### Edge Cases

- Provider sends malformed or partial payloads → the issue is created with what is parseable, and
  the parse failure is itself an evidence record. Ingestion never drops an event silently.
- Clock skew between provider and Healer → events carry both observed and received timestamps;
  ordering uses observed, retention uses received.
- An issue receives no further events but is never resolved → it becomes stale after a configured
  window and is surfaced, not silently closed.
- Two issues turn out to be the same → they can be merged, preserving both evidence sets and
  recording the merge as an event; a merge is reversible.
- Evidence exceeds a size limit (a 40 MB stack dump) → a bounded excerpt plus a reference is
  stored; the full payload is never inlined.
- An issue is deleted at tenant request → evidence and audit records for it are deleted too, and
  the deletion itself is recorded.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST model a single `Issue` aggregate with a `kind` of `production_incident`,
  `user_report`, `monitoring_alert`, `regression`, `automated_detection` or `knowledge_drift`, and
  MUST route all kinds through one investigation pipeline up to the decision point.
- **FR-001a**: `knowledge_drift` issues — a document disagreeing with code or with observed reality
  (004, 005) — MUST terminate at human adjudication. The system MUST NOT reproduce, patch or
  auto-resolve them in either direction: only a person knows whether the document is stale or the
  code is wrong.
- **FR-002**: System MUST compute a deterministic fingerprint for each incoming signal from
  component, environment, normalised error signature, endpoint and error code, and MUST attach
  signals with an identical fingerprint to the same open issue.
- **FR-003**: Normalisation MUST remove volatile parts of an error signature — identifiers, line
  offsets from generated code, timestamps, memory addresses, URLs' variable segments — before
  fingerprinting, and the normalisation rules MUST be versioned.
- **FR-004**: Ingestion MUST be idempotent per provider delivery identifier; a retried delivery
  MUST NOT create duplicate events.
- **FR-005**: An issue MUST reopen rather than duplicate when a matching signal arrives within the
  configured reopen window, and MUST create a new issue linked as a recurrence outside it.
- **FR-006**: System MUST maintain an explicit issue state machine, persisted, with every
  transition recorded as an event carrying who or what caused it.
- **FR-007a**: The `Evidence` type set is closed and owned by this feature. A consumer needing a new
  kind of evidence — a budget degradation record (002 FR-012), a discovered graph fact (004) — MUST
  have it added here rather than overloading `tool_output_summary`, which is a tool's output and
  nothing else. All four architecture-discovery shapes crossing the runner boundary
  (`component_candidate`, `deployment_unit_candidate`, `dependency_observation`, `repository_ref` —
  012 `contracts/runner-protocol.md`) are persisted as the single type `graph_fact`: the transport
  contract is closed per fact family, while the evidence type answers "what did we observe about the
  architecture", which is one kind of observation.
- **FR-007**: System MUST record `Evidence` as immutable, append-only records, each carrying type,
  source system, source reference, observed timestamp, captured excerpt, and the identifier of the
  step that produced it.
- **FR-008**: Evidence links MUST be emitted by the step that produced them. The system MUST reject
  any attempt to write an evidence link attributed to a different step, and MUST NOT support
  generating evidence links retrospectively.
- **FR-009**: Any persisted conclusion — diagnosis, impact assessment, verification verdict,
  support answer — MUST reference ≥ 1 evidence record. Persistence MUST fail otherwise.
- **FR-010**: When an original source becomes unavailable, its evidence MUST transition to
  `detached` retaining its captured excerpt and a human-readable source label, and MUST NOT be
  deleted for that reason alone.
- **FR-011**: System MUST bound the stored size of any single evidence excerpt by configuration,
  storing a reference to the full payload rather than inlining it.
- **FR-012**: System MUST record an audit entry for every agent action and every policy decision,
  containing actor, action, reason, evidence references, model identifier, prompt version, tools
  invoked, policy decision and outcome. The audit entry is the index over **every** actor — human,
  system, runner, agent — and its `action` MUST be a registered action key (002), so that executed
  mutating actions can be reconciled against policy decisions. The model, prompt version, token,
  cost and tool fields MUST resolve through the agent run reference (012 FR-033) rather than being
  stored a second time (C-13).
- **FR-013**: System MUST expose timeline, evidence graph and audit views as queries over the same
  evidence and event records, computed deterministically without model involvement. The timeline MUST
  be a **union** over `issue_event` (domain facts) and 012's `workflow_transition` (machine steps):
  the two tables have different grains and neither is total on its own, so a timeline built from
  either alone is incomplete (C-14).
- **FR-014**: System MUST publish domain events for issue lifecycle transitions through a
  transactional outbox, so consumers cannot observe a transition that was rolled back.
- **FR-015**: Every issue, evidence record, event and audit entry MUST carry `tenantId`, and every
  read MUST be constrained by the `tenantId` from the authenticated context. A request for another
  tenant's issue MUST return not-found, never forbidden.
- **FR-016**: System MUST support merging two issues, preserving both evidence sets, recording the
  merge as an event, and allowing the merge to be undone.
- **FR-017**: System MUST mark an issue as stale after a configured period without new signals or
  progress, and surface it rather than closing it automatically.
- **FR-018**: System MUST support deletion of a tenant's issue and all derived evidence and audit
  records on request, recording that the deletion occurred without retaining the deleted content.
- **FR-019**: Ingestion MUST NOT lose events on downstream failure; an event that cannot be
  processed MUST be retained for retry, and repeated failure MUST be observable.
- **FR-020**: System MUST record issue-to-issue relationships of kind `related`, `recurrence_of` and
  `merged_into`, and MUST correlate a user report with an alert sharing a component and time window as
  `related` **without merging them**. Correlation MUST be deterministic — a named rule over component,
  environment and window, recorded with the relationship so it can be explained and recomputed. No
  model proposes a relationship, and a `related` link MUST NOT change either issue's state.
- **FR-021**: A human MUST be able to close an issue, which resolves it with resolution kind
  `self_resolved` and no verification evidence. Consumers that require verification MUST NOT treat it
  as a verified resolution (C-09) — 009 escalates such a ticket rather than releasing it.

### Key Entities

- **Issue**: the unit of investigation. Kind, tenant, component, environment, severity, state,
  fingerprint, first/last seen, occurrence count, relationships to other issues (recurrence,
  related, merged-into).
- **IssueRelationship**: a link between two issues — `related`, `recurrence_of` or `merged_into` —
  carrying the deterministic rule that produced it (FR-020).
- **IssueEvent**: append-only record of what happened to an issue — state transitions, signals
  received, actions taken. The domain-fact half of the timeline; the machine-step half is 012's
  `WorkflowTransition` (C-14).
- **Evidence**: an immutable observation. Type (log pattern, trace, metric window, deploy, commit,
  test result, document excerpt, tool output), source system, source reference, observed time,
  captured excerpt, producing step, reference state (`linked` | `detached`).
- **EvidenceLink**: the typed relationship between a conclusion and the evidence supporting it,
  carrying the step that asserted it.
- **AuditEntry**: what an actor did and under which policy decision — one index over every actor,
  whose model and prompt fields resolve through the referenced `AgentRun` (012).
- **PromptVersion**: an immutable, addressable prompt revision referenced by agent runs.
- **NormalisationRuleset**: versioned rules used to produce fingerprints, so a fingerprint can be
  explained and recomputed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A burst of ≥ 10 000 signals sharing a root cause produces exactly one issue.
- **SC-002**: 100% of persisted conclusions carry at least one resolvable evidence reference,
  verified by a continuous invariant check.
- **SC-003**: 0 evidence records are mutated after creation, verified by an append-only constraint
  and an audit of update attempts.
- **SC-004**: 0 cross-tenant reads succeed in the isolation test matrix covering every endpoint.
- **SC-005**: The timeline for any issue is reproducible: rendering it twice from the same records
  produces identical output.
- **SC-006**: Ingestion sustains the design signal rate with end-to-end latency from provider
  delivery to issue visibility under the target defined in the plan, and 0 events lost under
  induced downstream failure.
- **SC-007**: Every audit entry for an agent action resolves to a retrievable prompt version and
  model identifier.

## Assumptions

- Fingerprint inputs are available for the first adapter set; providers that cannot supply a
  component or environment fall back to a configured default rather than failing ingestion.
- Reopen window, stale window and excerpt size limit are configuration, not constants, and their
  starting values are tuned on the stage-0 incident audit rather than guessed.
- Evidence retention is per tenant and shorter than issue retention; an issue outliving its
  evidence keeps its conclusions with `detached` references.
- This specification owns the issue and evidence substrate only. Context collection (003),
  diagnosis (006) and policy (002) consume it and are specified separately.
- The outbox pattern and event schema are shared infrastructure defined in 012.
