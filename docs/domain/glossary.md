# Domain glossary

Terms that cross spec boundaries, with the spec that owns each. A term used differently in two specs
is a defect — the whole point of this page is to make that visible.

## Core

| Term | Owner | Meaning |
|------|-------|---------|
| **Issue** | 001 | The unit of investigation. One aggregate for every source — production incident, user report, monitoring alert, regression, automated detection, knowledge drift. All kinds pass through one pipeline up to the decision point |
| **Evidence** | 001 | An immutable observation: type, source system, source reference, observed time, captured excerpt, and the step that produced it. Not knowledge |
| **EvidenceLink** | 001 | The typed relationship between a conclusion and its supporting evidence, carrying the step that asserted it. A step may only write links about itself |
| **Fingerprint** | 001 | The deterministic grouping key. Computed from component, environment, normalised error signature, endpoint and error code, under a recorded `normalisation_ruleset` version |
| **AuditEntry** | 001 | What an actor did, under which policy decision. All actors — human, agent, runner, system |
| **AgentRun** | 012 | One agent invocation: model, prompt version, tokens, cost, tool-call digests, outcome. The agent-side view of the same fact as an audit entry, not a second store (C-13) |

## Knowledge and expectation

| Term | Owner | Meaning |
|------|-------|---------|
| **Knowledge document** | 005 | An authored claim, with provenance, freshness and version. Rots — unlike evidence |
| **ExpectedBehavior** | 005 | What the system is *supposed* to do. Seeded from artefacts, drafted, then **adopted by a human**. Only adopted entries anchor verification |
| **RegressionTestBinding** | 013 | One test in the customer's repository bound to one adopted `ExpectedBehavior` version. A regression scenario is an `ExpectedBehavior`, not a second entity |
| **AnchorGrant** | 005 | The row that makes an expectation nameable as an anchor. 008 references the grant id; an unadopted expectation is unnameable, not merely rejected |
| **KnowledgeDrift** | 005, 004 | A document disagreeing with code or with observed reality. An `Issue` kind that terminates at human adjudication and never enters reproduction or change |
| **Provenance** | 004, 005 | How a fact came to exist: human-authored, machine-generated, machine-generated-and-adopted; or for graph edges, observed / derived / inferred. Affects trust and anchor eligibility |

## System model

| Term | Owner | Meaning |
|------|-------|---------|
| **Component** | 004 | The base unit of a customer's system. Narrow type plus open `characteristics`. Never called a service |
| **DeploymentUnit** | 004 | What actually ships. A monolith is many components and one deployment unit |
| **ImpactClosure** | 004 | Traverses every edge, has no confidence parameter, monotone in the edge set. The only result type a policy input or impact classification accepts |
| **KnownSubgraph** | 004 | The filtered view for display and explanation. Accepted by no predicate — nominally branded so the compiler enforces it |
| **Blast radius** | 004 | The closure reachable from a change, each path carrying its weakest-edge confidence |

## Investigation and change

| Term | Owner | Meaning |
|------|-------|---------|
| **ContextSnapshot** | 003 | The immutable, versioned context package collected for an issue, with a `collection_gap` for every source not collected |
| **Collection gap** | 003 | A recorded absence — what was not collected, why, and whether redaction withheld it. Itself an evidence record, which is what makes an honest `UNKNOWN` persistable |
| **Classification** | 006 | Whether the issue is a code problem at all. Runs before hypothesis generation; `UNDETERMINED` fails closed |
| **Rung** | 007 | A position on a reproduction ladder. There are **two**, selected by `observableLocation` (C-24): server — `unit` · `request` · `data` · `concurrency` · `load` · `external_state`; client — `client_unit` · `client_request` · `client_journey`. The engine starts at the cheapest rung **of the selected ladder**; a client-only observable is never attempted on the server ladder, where it cannot produce a `FAIL` in principle |
| **observableLocation** | 006 | `server` · `client` · `undetermined`, carried on the reproduction directive and derived deterministically from evidence — **never from `issue.kind`**. `undetermined` yields `INCONCLUSIVE` rather than a guess (C-26) |
| **INCONCLUSIVE** | 007 | A first-class reproduction outcome routed to a human with accumulated evidence. Not a failure |
| **Recipe** | 007 | How to materialise a fixture, as distinct from the fixture's data. An anonymised extract has no recipe, because describing it precisely enough to regenerate is a way of carrying it |
| **ChangePlan** | 008 | Files, regression test and anchor, declared and policy-evaluated before any write. Crosses as paths only; the patch is written in the runner and never crosses (ADR 0010) |
| **FixAttempt** | 008 | A preserved record of an attempt that failed, with its evidence. Never discarded |
| **Split** | 011 | `dev` or `benchmark` on a golden dataset entry — mandatory, never updated, and on the entry rather than on dataset membership so an incident cannot be republished into the sealed set. The first twenty adjudicated real incidents are `benchmark`; iteration uses `dev` and synthetic material (C-29) |
| **split_scope** | 011 | What a run actually scored, computed rather than declared. Only a `benchmark` scope can back a threshold, and it is carried onto the derivation by the same composite foreign key that keeps the synthetic and completion copies honest |

## Control

| Term | Owner | Meaning |
|------|-------|---------|
| **Policy decision** | 002 | `ALLOW` · `DENY` · `REQUIRE_APPROVAL`, from a pure function of a closed input record, under a recorded rule version. No clock, no repository, no model |
| **AutonomyGrant** | 002 | Permission for one action, in one scope, at one level. Per tenant, component, environment, issue type and action — never global |
| **ACTION_CEILING** | 002 | The product-level maximum a tenant cannot exceed. A function of action class **and** whether the undo is attested (C-18) |
| **Reversible action** | 010 | An action declaring a precondition, an action, a verification and an undo, with a passing undo test as its admission gate |
| **Capability** | ADR 0008 | An object an irreversible operation takes as an argument and cannot obtain any other way. What "permissions are what tools grant" means concretely |
| **ThresholdDerivation** | 011 | The row that makes one of the four autonomy-governing numbers a derived fact: the threshold, its value, the run, dataset version, metric and scored real denominator. Consumed by 002 (the threshold in effect) and by 012's `gate-ceiling` (a raise must cite one). Cannot be inserted citing a synthetic, partial, unrepeatable or `dev`-scoped run — a composite foreign key and five check constraints, not validation |
| **Derivation artifact** | 011 | The committed export of a derivation, under `docs/derivations/`, that a build with no database can resolve. The row stays the authority; the artifact is provenance, and the two are reconciled in both directions (C-30) |
| **Clamp** | 002, 006, 007, 009, 011 | A product bound configuration cannot cross, written as a literal plus a constant in code with a test asserting they agree. Used where lowering a value is individually rational and collectively removes a stop rule — `min_real_yield`, the predicate 2 trust floor, per-rung repeat counts, the escalation cap and budgets, the hypothesis threshold (C-32) |

## Deployment

| Term | Owner | Meaning |
|------|-------|---------|
| **Control plane** | ADR 0001 | Ours: issues, evidence, policy, agent orchestration, knowledge, dashboard. Model calls over customer source run in the runner (ADR 0010) |
| **Execution plane** | ADR 0001 | The customer's: repository checkout, sandbox, tests, code intelligence, collection and redaction, remediation |
| **Boundary crossing shape** | 012 | A member of the closed, versioned schema set that may cross between planes. `contracts/runner-protocol.md` is the single authority for its membership |

## Words we deliberately do not use

| Avoid | Use | Why |
|-------|-----|-----|
| Service | Component | "Service" commits the model to microservices and makes a monolith a special case (ADR 0007) |
| Confidence (as a gate) | A structural predicate | Model-reported confidence is never a gate predicate (constitution IV) |
| Verified (of a merged change) | Merged | At L2 Healer neither merges nor deploys, so it never observes its own change in production (C-09) |
| Resolved (on merge) | Resolved means production-verified | `IssueResolved` releases customer-facing drafts; firing it on merge tells people a problem is fixed before anything checked |
| Masking rejection *threshold* | Deterministic detection and a hard refusal | 008 FR-014 inspects the diff and FR-015 refuses; SC-009 is a fixture outcome. Calling it a threshold in a table of numbers to tune is how it becomes tunable |
