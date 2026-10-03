# Feature Specification: Engineering foundation — monorepo, gates, runner packaging, and observing ourselves

**Feature Branch**: `012-engineering-foundation`

**Created**: 2026-09-23

**Status**: Draft

**Input**: The substrate every other specification stands on — one monorepo with boundaries enforced by lint rather than by review, gates that run on a laptop, a runner that is a shipped and blindly debuggable product, workflows that never wait inside a job, versioned prompts, per-tenant provider configuration, and Healer's own tracing built as the same dataset as the customer's audit trail.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The gates run on a laptop (Priority: P1)

An engineer runs one command before pushing. It lints, typechecks, builds, runs unit and e2e tests,
regenerates the schema and the API contract, checks that nothing drifted, applies the migrations to
a fresh database, and reports coverage against the floors. What CI will do, it has already done.

**Why this priority**: a gate that cannot be run locally is a gate developers route around — they
push and wait, then patch the gate rather than the code. Every other quality claim in this project
depends on the gates being cheap to obey.

**Independent Test**: on a clean checkout with no access to any hosted service, run the single CI
target; it completes and its verdict matches what the CI system produces for the same commit.

**Acceptance Scenarios**:

1. **Given** a clean checkout and the documented prerequisites, **When** the CI target is run
   locally, **Then** it executes every gate CI executes, and CI runs no step absent from that target.
2. **Given** a generated artifact was edited by hand, **When** the drift check runs, **Then** it
   fails and names the file and the command that regenerates it.
3. **Given** a migration that does not apply to the previous release's schema, **When** the
   applicability gate runs, **Then** it fails before the change can merge.
4. **Given** a package whose coverage falls below its declared floor, **When** the coverage gate
   runs, **Then** the build fails and names the package and the delta.
5. **Given** a gate fails, **When** the engineer reads the output, **Then** it names the gate, the
   offending artifact, and one command that reproduces the failure locally.

---

### User Story 2 - No endpoint and no reversible action ships untested (Priority: P1)

Two invariants are not left to code review. Every HTTP endpoint has a test proving another tenant's
data returns not-found. Every action declared reversible has a test that exercises its undo. Adding
either without its test fails the build.

**Why this priority**: cross-tenant retrieval is the failure that ends the company, and an undo that
was never executed is a promise, not a capability. Both are enforceable by enumeration, so neither
should depend on a reviewer remembering.

**Independent Test**: add an endpoint with no isolation test and an action declared reversible with
no undo test → the build fails twice, naming each.

**Acceptance Scenarios**:

1. **Given** the set of endpoints enumerated from the generated contract, **When** the isolation
   gate runs, **Then** any endpoint without a tenant-isolation e2e test fails the build.
2. **Given** an endpoint's isolation test exists, **When** it runs, **Then** it asserts that a
   request for another tenant's resource returns not-found, never forbidden (001 FR-015).
3. **Given** the reversible action catalogue (002 FR-009), **When** the undo gate runs, **Then** any
   action lacking a test that exercises precondition, action, verification and undo fails the build
   (002 SC-005).
4. **Given** a database schema change, **When** the change set contains no update to the owning
   specification's data model, **Then** the build fails.

---

### User Story 3 - Boundaries are enforced by pattern, not by a name list (Priority: P1)

A developer imports another module's infrastructure layer, or reaches for a provider SDK outside its
adapter, or reads `process.env` in a handler. The build fails before review. Six months later a new
module is added and inherits every rule without anyone editing a configuration file.

**Why this priority**: architectural rules that live in a reviewer's memory decay in weeks. A rule
expressed as an enumerated list of module names goes stale the moment a module is added — which is
exactly when enforcement matters most.

**Independent Test**: create a new module that violates each forbidden pattern, change no lint
configuration → each violation is reported.

**Acceptance Scenarios**:

1. **Given** a module importing another module's `infrastructure` internals, **When** lint runs,
   **Then** it fails naming the importing file and the rule.
2. **Given** a brand-new module added with no change to the lint configuration, **When** it violates
   a boundary rule, **Then** the violation is still caught.
3. **Given** a file exceeding the size, function-length, complexity or nesting limit, **When** lint
   runs, **Then** it fails; test files are exempt from the size limits only.
4. **Given** a developer needs a genuine exception, **When** they suppress a boundary rule inline,
   **Then** the suppression is rejected; an exception exists only as a recorded entry referencing an
   ADR.

---

### User Story 4 - The runner is a product we ship, and we debug it blind (Priority: P1)

A customer's runner starts failing. Healer support cannot see the customer's logs, source or data —
by design. The runner produces a diagnostic bundle of structured facts: versions, capability set,
task outcomes, normalised error signatures, resource state, clock offset, contract-rejection counts.
That is enough to resolve the call.

**Why this priority**: the hybrid split (D-02) is the product's security story, and it is worthless
if the first serious support call is answered with "please send us your logs". Blind debuggability
is a design constraint on every diagnostic surface the runner has, and it cannot be retrofitted.

**Independent Test**: plant unique markers in a sandbox's logs, environment and source tree, run a
full task, then inspect every outbound payload and the diagnostic bundle → no marker appears.

**Acceptance Scenarios**:

1. **Given** a runner and a control plane with incompatible protocol versions, **When** the runner
   registers, **Then** it refuses work, reports `incompatible` with both versions, and the affected
   tenant capabilities show as unavailable — never a silent no-op or a partial execution.
2. **Given** a payload that does not match the evidence contract, **When** the runner attempts to
   send it, **Then** egress validation blocks it, and the control plane's ingress validation would
   reject it independently.
3. **Given** the control plane is unreachable, **When** the runner is executing a task, **Then** it
   completes the task, persists the structured result durably, and re-delivers it idempotently on
   reconnect.
4. **Given** the offline buffer reaches its bound, **When** more results are produced, **Then** the
   runner reports degraded with a count, rather than discarding results silently.
5. **Given** a support request, **When** the diagnostic bundle is generated, **Then** it contains
   only structured facts and redacted configuration keys, and a test with planted markers proves no
   customer content is present.
6. **Given** a runner upgrade, **When** it is applied, **Then** in-flight work is drained rather than
   lost, and the previous version can be restored.

---

### User Story 5 - Never wait inside a job (Priority: P1)

A workflow needs to wait twenty minutes for the customer's CI, then an hour of canary observation.
No job sleeps, polls or blocks. The workflow persists its state, the external system calls back, and
the next short job runs. A build check fails on any handler that tries to wait.

**Why this priority**: this single rule is what makes BullMQ sufficient and keeps Temporal out of
the architecture (D-22, constitution VI). Violating it is not a style issue — it is the thing that
would eventually force a migration, and it becomes unfixable once a dozen handlers depend on it.

**Independent Test**: add a job handler that sleeps or polls an external system → the check fails;
run a workflow whose external step never calls back → the workflow sits in a persisted waiting
state and is visible, with no worker occupied.

**Acceptance Scenarios**:

1. **Given** a handler containing a blocking wait, a delay or a polling loop against an external
   system, **When** the check runs, **Then** the build fails naming the handler.
2. **Given** a workflow reaching a long wait, **When** it suspends, **Then** its state is persisted
   with the awaited event, and no worker or connection is held.
3. **Given** an inbound callback arrives twice, **When** it is processed, **Then** the effect occurs
   once; a callback for an unknown, completed or abandoned workflow is recorded, not discarded.
4. **Given** a job exceeds the declared maximum wall-clock, **When** the limit is reached, **Then**
   it is terminated and recorded as a violation — the static check can be evaded, the runtime limit
   cannot.
5. **Given** a completed workflow, **When** its persisted transitions are read, **Then** they
   reconstruct the run without replaying it, and they are the same records the audit trail serves
   (001 FR-013).

---

### User Story 6 - Observing ourselves is the audit trail (Priority: P2)

An engineer asks why last Tuesday's run cost eleven dollars. A customer's change-management reviewer
asks why Healer proposed a particular patch. Both questions are answered from the same records:
model, prompt version, tokens, tool calls, decision path, cost, correlation identifier.

**Why this priority**: building operational telemetry and the customer audit trail as two systems
guarantees they disagree, and the moment they disagree neither can be trusted. These are the fields
001 FR-012 requires — recorded once here, and reached from 001's audit entry by reference (C-13).

**Independent Test**: run one issue end to end, then reconstruct its full decision path from the
audit records alone, and independently confirm that no model, prompt-version, token or cost field for
that run is stored anywhere but the agent run record.

**Acceptance Scenarios**:

1. **Given** any agent run, **When** its record is read, **Then** it carries model, prompt version,
   token counts, cost, tools invoked, decision path, structured outcome and duration.
2. **Given** an issue processed end to end, **When** its correlation identifier is queried, **Then**
   every job, agent call, runner task, callback, log line, evidence record and audit entry for that
   run is retrievable by it.
3. **Given** logs, traces and metrics produced during a run with planted secrets and customer
   content, **When** they are inspected, **Then** no secret and no customer content appears.
4. **Given** reported spend for an issue, **When** it is compared with the sum of its agent run
   records, **Then** they agree — budgets (002 FR-011) consume this source, not a parallel one.

---

### User Story 7 - An old audit entry resolves to the exact prompt (Priority: P2)

A diagnosis from three months ago is questioned. The audit entry names a prompt version; the
registry returns that exact text, its parameters and its eval history. The prompt has changed nine
times since. None of that matters, because versions are immutable.

**Why this priority**: without this, 001 SC-007 cannot hold and the benchmark (011) measures a
moving target — a score improvement becomes indistinguishable from a prompt edit (D-07).

**Independent Test**: record a run, publish four newer prompt versions, then resolve the original
run's prompt version → exact original content returned.

**Acceptance Scenarios**:

1. **Given** a published prompt version, **When** anything attempts to modify or delete it, **Then**
   the attempt is rejected — versions are immutable and referenced versions are never removed.
2. **Given** an audit entry from an earlier release, **When** its prompt version is resolved,
   **Then** the exact template, parameters and model defaults of that version are returned.
3. **Given** a prompt version with no recorded eval result, **When** it is proposed as the default
   for a production path, **Then** the promotion is refused.
4. **Given** an agent run, **When** a model output attempts to alter the prompt in use, **Then** it
   cannot — prompt selection is deterministic and pinned per agent.

---

### User Story 8 - Misconfiguration fails at startup, not at 3am (Priority: P2)

A deployment goes out with a missing credential reference. The process refuses to start and names
the key. It does not start, serve traffic for six hours, and fail on the first agent call of the
night. A tenant on their own Bedrock account never has a request silently fall back to Healer's key.

**Why this priority**: configuration failures discovered lazily are discovered during an incident.
Per-tenant provider configuration (D-15) is the enterprise answer to "does our code reach your model
vendor" — retrofitting it into a code base that assumes one global client is a rewrite of every call
site.

**Independent Test**: remove a required configuration key → the process refuses to start naming it;
configure a tenant for BYO, induce a provider failure → the request fails and is recorded, and
nothing is routed to the Healer-managed provider.

**Acceptance Scenarios**:

1. **Given** a missing or malformed required configuration value, **When** the process starts,
   **Then** it refuses to start and names the key and the expected shape; no required value is
   silently defaulted.
2. **Given** a tenant configured with their own provider, **When** any model call is made for that
   tenant, **Then** it is routed to that provider; on failure it is refused and recorded, never
   retried against a different provider.
3. **Given** a commit containing secret material or an environment file, **When** the secret gate
   runs, **Then** the build fails.
4. **Given** a credential, **When** it is needed, **Then** it is resolved from the secret manager by
   reference; no secret value exists in the repository or in a built artifact.

---

### User Story 9 - A new developer starts without tribal knowledge (Priority: P3)

Someone joins, clones the repository, follows the documented commands, and has Postgres, Redis and a
local runner up with the test suite passing. They ask nobody anything.

**Why this priority**: valuable but not blocking — the team can absorb a rough setup for a while.
It earns its place because the same documented path is what a design partner follows, and because a
setup nobody verifies is documentation that is already wrong.

**Independent Test**: on a clean machine image, execute only the documented commands → the system
runs and the test suite passes.

**Acceptance Scenarios**:

1. **Given** a clean checkout, **When** the documented setup commands are run, **Then** Postgres with
   pgvector, Redis and a local runner are available and the test suite passes, with no undocumented
   manual step.
2. **Given** the documented setup, **When** it is executed on a clean image by an automated job,
   **Then** it succeeds — documentation rot fails the build rather than being discovered by a hire.
3. **Given** local development and the v1 control-plane deployment, **When** their prerequisites are
   listed, **Then** neither requires Kubernetes or Terraform.

---

### User Story 10 - A coding agent implements a task, and only the gates decide whether it lands (Priority: P2)

A coding agent takes one task from a feature's `tasks.md`, works in its own worktree and branch, writes
the failing test first, implements, runs the single gate command and opens a pull request that cites
the task and the requirements it satisfies. A human reviews and merges. The agent never merges, and a
change set it authors cannot touch the rules that judge it — gates, lint and boundary configuration,
coverage floors, specifications, ADRs, the constitution.

**Why this priority**: the task lists hold over a thousand tasks, and the gates of FR-007 already
exist for human authors. A coding agent is a developer that follows instructions literally, so the
same controls make its work safe — provided they are enforced by the build and not by its prompt
("permissions are what tools grant, not what prompts say" applies to our own tooling). It is also the
product's own ceiling applied to ourselves: Healer's development runs at L2, as its customers' does.
The seams stay human — `/speckit-analyze` found all of its ≈110 findings between specifications, not
inside one, and that is where a literal implementer fails.

**Independent Test**: give an agent one `[P]` task on a clean checkout → it produces a pull request
whose new tests fail against the base revision and whose head passes the gate command. Then give it a
task that can only be completed by editing a gate or a spec → it stops and reports instead, and a
hand-crafted agent change set touching a protected path is refused by the build.

**Acceptance Scenarios**:

1. **Given** a task assigned to an agent, **When** its pull request is opened, **Then** it references
   the task identifier and the requirement identifiers it satisfies, and the gate command passed on its
   head before review was requested.
2. **Given** an agent change set that alters behaviour, **When** the red-first gate runs, **Then** at
   least one test added or modified in the change set fails against the base revision's production
   code — a test that was never red proves nothing about the change.
3. **Given** an agent change set that modifies a protected path, **When** the scope gate runs, **Then**
   the build fails naming the path, and the change can land only with a human as its author.
4. **Given** an agent change set that edits or deletes an assertion of a pre-existing test, **When**
   the scope gate runs, **Then** the build fails — an implementer weakening its own verification
   anchor is the circularity Principle II forbids.
5. **Given** a task whose completion needs a decision absent from the spec, plan, research and
   `docs/decisions.md`, **When** the agent reaches it, **Then** it stops and records the open question
   on the task rather than choosing.
6. **Given** an agent's pull request, **When** merge is attempted, **Then** it requires a human
   approval; no agent credential holds merge permission or counts as an approval.
7. **Given** a task post in the project's chat channel from an allowlisted user, **When** the owner
   confirms the card the bot shows, **Then** a task line or tracked issue exists and an agent job is
   dispatched on it; **and** a post from any other sender causes nothing and leaves an audit entry.
8. **Given** a log or QA finding posted to the channel, **When** it is received, **Then** it enters
   ingestion as a signal and no agent job is dispatched on it as a task.
9. **Given** an agent job started from the channel, **When** it runs and ends, **Then** the same channel
   shows its start, current step and one of the three outcomes of FR-058/FR-059, with a link to the
   pull request or draft.

---

### Edge Cases

- A customer upgrades the runner ahead of the control plane → the compatibility range is evaluated
  in both directions; an unsupported-newer runner reports `incompatible` and stops accepting work
  rather than guessing at an older contract.
- The control plane ships a contract change while runners are offline → the runner's buffered
  results are validated against the contract version they were produced under, not the current one;
  an unsupported version is reported, never silently coerced.
- Clock skew between runner and control plane → every record carries both produced-at and
  received-at; ordering uses produced-at, retention uses received-at, and the measured offset is part
  of the heartbeat (consistent with 001's edge case on provider clock skew).
- Two branches both regenerate the OpenAPI contract → the artifact is regenerated from code during
  the merge check, so a textual merge conflict cannot produce a contract that matches neither branch.
- A boundary lint pattern produces a genuine false positive → the exception is a recorded entry with
  an ADR reference and an owner, never an inline suppression, and the exception list is reviewed.
- CI wall-clock grows past its declared budget → the duration is reported per run and the budget
  breach is surfaced, because a slow gate is a gate that gets skipped.
- A secret is rotated while a runner is offline → on reconnect the runner re-resolves credentials
  from the secret manager before resuming; expired credentials mid-task fail the task with a typed
  error rather than a partial result.
- A migration is genuinely irreversible (a dropped column) → it must be explicitly marked as such
  with a recorded approval; the default path is reversible and the down migration is tested.
- A prompt version is superseded but still referenced by an old audit entry → it is retained
  indefinitely; garbage collection may never remove a referenced version.
- The pgvector index is lost or corrupted → it is rebuilt from Postgres, which is the source of
  truth; no data is unrecoverable because only the secondary index was damaged.
- A tenant's BYO provider is unavailable for hours → the tenant's AI paths degrade per 002 FR-012
  and the degradation is recorded; no cross-provider failover occurs.
- An agent's task turns out to require a spec, gate or ADR change → the agent stops with the task
  unfinished and the reason recorded; a human makes the protected change, and the task resumes after
  it lands. The agent never bundles the rule change with the code that needs it.
- Two agents work `[P]` tasks that conflict at merge → the second rebases and re-runs the gate
  command; it never edits the first agent's files to resolve the conflict.
- The author identity of a change set cannot be determined → it is treated as agent-authored, so the
  protected-path rules apply (fails closed).
- A task is pure refactoring, documentation or configuration with no behaviour change → the task line
  carries an explicit no-behaviour marker and the red-first gate is skipped for it; an absent marker
  means the gate runs.

## Requirements *(mandatory)*

### Functional Requirements

**Monorepo and module boundaries**

- **FR-001**: System MUST be organised as one repository containing the applications `api`,
  `worker`, `mcp-server`, `runner` and `dashboard`; the domain packages under `packages/domain/`
  (`issues`, `evidence`, `policy`, `context`, `architecture`, `knowledge`, `diagnosis`,
  `reproduction`, `change`, `support`, `remediation`, `evaluation`); and the shared packages
  `agents`, `llm`, `code-intelligence`, `integrations`, `prompts`, `events`, `sandbox`, `workflow`,
  `boundary-contract` and `shared`. Each package MUST declare a public entry surface; imports
  reaching past it into another package's internals MUST fail the build. **This list is the
  documented package set** referenced by the governance clause of the constitution, and
  [plan.md](plan.md) must agree with it.
- **FR-002**: Boundary rules MUST be expressed as path patterns, never as enumerated module names.
  Adding a module MUST NOT require editing lint configuration for the module to be governed, and a
  fixture proving this MUST exist in the test suite.
- **FR-003**: The build MUST fail on: an import of another module's `**/*/infrastructure/**`; an AI
  provider SDK imported outside `llm/*/infrastructure`; `@prisma/client` imported outside
  `**/infrastructure/**` and `prisma/**`; `process.env` read outside `shared/config/**`. Each
  forbidden pattern MUST have a fixture that violates it and a test asserting the failure.
- **FR-004**: The build MUST enforce file length ≤ 400 lines, function length ≤ 300 lines,
  cyclomatic complexity ≤ 15 and nesting depth ≤ 4, with test files exempt from the length limits,
  and MUST reject direct console output in application code.
- **FR-005**: An exception to a boundary rule MUST exist only as a recorded entry referencing an ADR
  and naming an owner. Inline suppression of a boundary rule MUST be rejected.
- **FR-006**: Adding a runtime dependency MUST fail the build unless an ADR referencing that
  dependency exists in the same change set (constitution VIII).

**CI gates**

- **FR-007**: The system MUST expose a single command that runs every gate, executable from a clean
  checkout on a developer machine without access to any hosted service. The CI system MUST run that
  command and MUST NOT run a gate absent from it.
- **FR-008**: That command MUST include: lint including boundary and limit rules, typecheck, build,
  unit tests, end-to-end tests, generation of all generated artifacts, a generated-artifact drift
  check, migration applicability, coverage enforcement, contract drift, and a secret scan.
- **FR-009**: The drift check MUST regenerate every generated artifact — database client, database
  schema, OpenAPI document, generated API clients, event schemas — and MUST fail on any difference
  from the committed output, naming the file and the regenerating command. Hand-editing a generated
  artifact MUST be detectable by this check.
- **FR-010**: Migrations MUST apply cleanly to an empty database and to the previous release's
  schema, and each migration's reverse MUST be exercised by the gate.
- **FR-011**: Coverage floors MUST be declared per package, with higher floors for `policy`,
  `evidence`, the structured-output validation in `agents`, and tenant-isolation code paths. Falling
  below a floor MUST fail the build; lowering a floor MUST require a recorded decision.
- **FR-012**: The OpenAPI document and generated clients MUST be generated from code and committed;
  manual edits MUST be rejected by FR-009.
- **FR-013**: The gate set MUST enumerate every HTTP endpoint from the generated contract and MUST
  fail if any endpoint lacks a tenant-isolation end-to-end test asserting that another tenant's
  resource returns not-found (001 FR-015).
- **FR-014**: The gate set MUST enumerate every action in the reversible action catalogue (002
  FR-009) and MUST fail if any lacks an automated test exercising its precondition, action,
  verification and undo (002 SC-005).
- **FR-015**: A change set altering the database schema MUST also update the owning specification's
  data model; a gate MUST fail otherwise.
- **FR-016**: Every gate failure MUST name the gate, the offending artifact and a single local
  command that reproduces it. Total gate wall-clock MUST be recorded per run and compared against a
  declared budget.
- **FR-016a**: Two gates in [contracts/make-targets.md](contracts/make-targets.md) enforce rules this
  specification does not own, and neither gets an owning requirement here: `gate-evidence` derives
  from **001 FR-009** (no persisted conclusion without an evidence reference) and
  `gate-architecture-agnostic` from **constitution VII** (architecture-specific names live only in
  adapters). This feature owns only their enforcement and their failure output (FR-016); their meaning
  belongs to those two documents, as the assumption below states for every gate here.

**The runner as a shipped product**

- **FR-017**: The runner MUST be released as an independently versioned artifact with an immutable
  version identifier, a published checksum and a changelog. A published version MUST NOT be rebuilt
  in place.
- **FR-018**: Runner and control plane MUST exchange a declared protocol version, and the control
  plane MUST publish the range it supports. On a version outside that range the runner MUST refuse
  to accept work, MUST report `incompatible` with both versions, and the affected tenant
  capabilities MUST be shown as unavailable — never silently degraded and never partially executed.
- **FR-019**: The runner MUST support upgrade without losing in-flight work — draining current tasks,
  reporting, restarting — and MUST support restoring the previous version. Upgrade MUST be initiated
  by the customer; the control plane MUST NOT force it.
- **FR-020**: The runner MUST report health at a declared interval, carrying runner version, protocol
  version, capability set, resource state, last successful task and measured clock offset. Absence of
  heartbeats beyond a threshold MUST mark the capability unavailable and surface queued work, rather
  than accumulating it silently.
- **FR-021**: On loss of connectivity the runner MUST complete current work, persist results durably,
  and re-deliver them idempotently on reconnect. The buffer MUST be bounded; on reaching the bound the
  runner MUST drop oldest-first, report degraded with a count and record a collection gap for what was
  dropped. Nothing is discarded **silently** — but the runner buffer is **lossy with a record**, which
  is a different guarantee from control-plane ingestion durability (001 FR-019): once the bound is
  reached, an unbounded buffer would block the customer's systems, so the honest outcome is a recorded
  gap rather than a promise of no loss.
- **FR-022**: What may cross the control/execution boundary MUST be a closed, versioned schema set.
  **[contracts/runner-protocol.md](contracts/runner-protocol.md) is the single authority for its
  membership** — this requirement does not restate the list, because three divergent copies of a
  closed list is the same failure as having no closed list. Payloads MUST be validated
  against it at egress on the runner and independently at ingress on the control plane; a payload
  failing egress validation MUST NOT be sent, one failing ingress validation MUST be rejected and
  counted, and rejection counts MUST be visible to the tenant and to Healer.
- **FR-023**: Raw log bodies, source file contents beyond declared bounded excerpts, environment
  variable values and credentials MUST NOT be transmissible by any runner path. A test that plants
  unique markers in logs, environment and source tree MUST assert that no marker appears in any
  outbound payload.
- **FR-024**: The runner MUST produce a support diagnostic bundle containing only structured facts —
  versions, capability set, configuration keys with values redacted, task outcomes, normalised error
  signatures, resource statistics, contract-rejection counts, clock offset. The planted-marker test
  of FR-023 MUST also apply to this bundle. Healer support MUST be able to resolve a runner fault
  from this bundle alone.

**Workflow execution**

- **FR-025**: No job handler may block on an external event. Every long wait — CI completion, deploy,
  canary observation, human approval — MUST be a persisted workflow state plus an authenticated
  inbound callback.
- **FR-026**: A pattern-based check MUST fail the build on blocking wait constructs inside job
  handlers — sleeps and delays, polling loops against an external system, awaiting an external
  completion. An exception MUST follow FR-005.
- **FR-027**: A maximum job wall-clock MUST be declared and enforced at runtime; a job exceeding it
  MUST be terminated, recorded as a violation and surfaced. The static check alone is insufficient
  because it can be evaded.
- **FR-028**: Every job MUST be idempotent under re-delivery, keyed so that re-running produces no
  duplicate effect (001 FR-004).
- **FR-029**: The workflow state machine MUST be persisted in Postgres, with every transition
  recording cause, actor, input references, policy decision reference (002 FR-017), correlation
  identifier and timestamp. These transitions are the **machine-step** half of the timeline of 001
  FR-013, which reads them in union with 001's `issue_event` — the domain-fact half. Neither table is
  total on its own: a signal arriving is not a workflow transition and a job retry is not a domain
  fact (C-14). A second store of the transitions themselves MUST NOT exist, and no transition may be
  copied into `issue_event` or the reverse.
- **FR-030**: Inbound callbacks MUST be authenticated, idempotent and replayable. A callback for an
  unknown, completed or abandoned workflow MUST be recorded, never discarded.
- **FR-031**: Domain events MUST be published through a transactional outbox, provided here as shared
  infrastructure and consumed by 001 FR-014.

**Observing ourselves**

- **FR-032**: A correlation identifier MUST be minted when an issue or request enters the system and
  MUST be propagated through every job, agent call, runner task, callback, log line, evidence record
  and audit entry. Every runner-originated record MUST additionally carry `tenantId`, runner instance
  identifier and runner version.
- **FR-033**: Every agent run MUST record model identifier, prompt version, input and output token
  counts, cost, tools invoked, decision path, structured outcome and duration. It MUST be the single
  store of **the agent-run facts**, serving both Healer's operational tracing and the model and prompt
  fields the customer-facing audit trail of 001 FR-012 resolves through the agent run reference
  (C-13). A second store of those facts — a parallel telemetry table, a metrics pipeline holding cost
  per run — MUST NOT exist. 001's `audit_entry` is **not** such a store: it indexes every actor,
  including humans, runners and the system, and holds no model or token fields of its own. A
  runner-side run's record is written from its `agent_run_report`, and reported cost is reconciled
  against provider usage per tenant key.
- **FR-034**: Logging MUST be structured, with `tenantId` and correlation identifier on every line.
- **FR-035**: Secrets and customer content MUST NOT appear in logs, traces, metrics or error reports.
  Redaction MUST occur at the emission point, and a planted-marker test MUST assert absence.
- **FR-036**: Spend and execution time MUST be aggregated from the agent run records of FR-033 and
  exposed as the single source consumed by budgets (002 FR-011).
- **FR-037**: Healer operator access to a tenant's traces and run records MUST be tenant-scoped and
  MUST itself be audited.

**Prompt registry**

- **FR-038**: Prompts MUST be immutable, addressable, versioned artifacts. Editing MUST produce a new
  version; a published version MUST NOT be modified, and a referenced version MUST NOT be deleted.
- **FR-039**: Every agent run MUST record the prompt version used, and resolving that version MUST
  return the exact template, parameters and model defaults of that version (001 SC-007).
- **FR-040**: Each prompt version MUST carry its eval history, linked to benchmark runs (011). A
  version with no recorded eval result MUST NOT be promoted to the default for a production path.
- **FR-041**: Prompt selection MUST be deterministic and pinned per agent. Model output MUST NOT be
  able to alter the prompt in use.

**Configuration and secrets**

- **FR-042**: Secrets MUST NOT exist in the repository or in a built artifact; they MUST be resolved
  by reference from a secret manager. A gate MUST fail the build on detected secret material or a
  committed environment file.
- **FR-043**: Configuration MUST be validated against a schema at process start. A missing or
  malformed required value MUST cause the process to refuse to start, naming the key and expected
  shape. A required value MUST NOT be silently defaulted.
- **FR-044**: `process.env` MUST be read only within `shared/config/**` (FR-003) and exposed to the
  rest of the system as typed values.
- **FR-045**: LLM provider configuration MUST be per tenant — provider, endpoint or region, permitted
  model set, credential reference and data-residency flag — with Healer-managed access as the default
  and customer-supplied access (Bedrock, Vertex) selectable per tenant (D-15). It MUST be resolved
  per call from the tenant context, never from a process-global client — in the runner, for calls that
  run there (ADR 0010).
- **FR-046**: A tenant configured for their own provider MUST NOT have any request routed to the
  Healer-managed provider, including on failure, fallback or retry. Such a failure MUST be refused
  and recorded as a degradation (002 FR-012).
- **FR-046a**: A model call whose input includes content that may not cross the boundary MUST execute
  in the runner (ADR 0010, C-33). Its Healer-managed credential MUST be per tenant, spend-limited,
  revocable and resolved from the customer's secret manager; no directive may carry a credential, and
  no shared or proxied Healer credential may exist (C-34). A runner without the `inference` capability
  MUST refuse every agent directive (C-35).

**Storage**

- **FR-047**: Postgres MUST be the source of truth. Graph traversal MUST use recursive queries within
  Postgres. The vector index MUST be a secondary index only, fully rebuildable from Postgres, and a
  test MUST exercise the rebuild (D-05).
- **FR-048**: Every tenant-scoped table MUST carry `tenant_id` with an index leading on it, and
  tenant-scoped reads MUST pass through a query layer that applies `tenantId` from the authenticated
  context. A schema check MUST enumerate tables and fail on a tenant-scoped table without it (D-17).
- **FR-049**: Migrations MUST be reversible by default and MUST NOT contain heavy data logic. A
  destructive or irreversible migration MUST be explicitly marked and MUST carry a recorded approval.

**Local development**

- **FR-050**: A clean checkout MUST reach a running system and a passing test suite using only
  documented commands, with Docker Compose providing Postgres with pgvector, Redis and a local
  runner, plus a seeded fixture tenant. No undocumented manual step may be required.
- **FR-051**: The documented setup path MUST be executed by an automated job on a clean machine
  image, so that documentation rot fails the build.
- **FR-052**: Neither local development nor the v1 control-plane deployment may require Kubernetes or
  Terraform.

**Agent-driven development**

- **FR-053**: The unit of agent-authored work MUST be one task from a feature's `tasks.md`. Its merge
  request MUST reference the task identifier and the requirement identifiers the task cites, and MUST
  pass the gate command of FR-007 before review is requested.
- **FR-054**: Whether a change set is agent-authored MUST be determined from the authenticated identity
  the version-control and CI systems report, never from commit or pull-request text, which the author
  controls. An undeterminable identity MUST be treated as agent-authored.
- **FR-055**: An agent-authored change set MUST NOT modify a protected path, and MUST NOT edit or delete
  an assertion in a test that exists on the base revision. The protected-path list has exactly one
  authority, [contracts/make-targets.md](contracts/make-targets.md), and that list is itself protected.
- **FR-056**: An agent-authored change set altering behaviour MUST contain at least one added or
  modified test that fails when run against the base revision's production code. A task exempt from
  this carries an explicit no-behaviour marker in `tasks.md`; the absence of a marker means the rule
  applies.
- **FR-057**: No agent credential may hold merge permission or count toward the approvals a merge
  requires. Merge is a human action.
- **FR-058**: An agent MUST stop and record an open question on the task, rather than choose, when
  completing it needs a decision absent from the spec, plan, research and `docs/decisions.md`, or a
  change to a protected path.
- **FR-059**: Agents MAY work in parallel only on tasks marked `[P]`, each in its own worktree and
  branch. Every agent task run MUST declare a wall-clock and spend budget; a run exceeding either stops,
  leaves its branch with the reason recorded, and opens no pull request presented as complete.
- **FR-060**: Work reaches an agent from a chat channel only through an allowlisted sender. The
  allowlist MUST be control-plane configuration; a sender identifier read from message text MUST NOT
  confer any right. A message from any other sender MUST cause no task, signal or job and MUST be
  recorded in the audit trail (ADR 0016, C-48).
- **FR-061**: A chat post MUST be classified by structure into a *task* or a *finding*. A task post MUST
  become a task line or tracked issue before any agent job exists, so FR-053 holds; a finding MUST enter
  001 ingestion as a signal and MUST NOT start an agent job as a task.
- **FR-062**: The content of a chat post, including pasted logs, MUST reach an agent only as data in the
  task description. It MUST NOT alter the prompt in use (FR-041), the task identifier, a protected path
  or a budget.
- **FR-063**: An agent job started from a chat post MUST start only after the allowlisted owner confirms
  the task as the bot restated it. Relaxing this is a recorded decision, not a setting. **Proposed** —
  ADR 0016, pending confirmation.
- **FR-064**: Every agent job MUST report to the channel it was started from — start, current step, and
  one of: a pull request, a `needs-decision` draft, a stopped branch with the budget breach. Reports
  MUST carry identifiers and digests, never credentials or customer source, and MUST NOT be the only
  record: the pull request and the audit trail remain the record.
- **FR-065**: The chat channel MUST hold no merge, approval or administration right. It can ask for a
  job, confirm a card and read reports; the host refuses everything else (FR-057).

### Key Entities

- **RunnerInstance**: a registered runner belonging to a tenant — instance identifier, installed
  version, capability set, health state, last heartbeat, measured clock offset, buffer state.
- **EvidenceEnvelope**: the validated unit crossing the boundary — contract version, payload type
  from the closed enumeration, produced-at, received-at, tenant, correlation identifier, structured
  body. The only shape permitted to cross.
- **WorkflowRun**: a persisted state machine instance — type, current state, awaited event, tenant,
  correlation identifier. Serves both execution and the audit trail.
- **WorkflowTransition**: one recorded state change — from, to, cause, actor, input references,
  policy decision reference, timestamp. The machine-step half of the timeline of 001 FR-013 (C-14).
- **AgentRun**: the record of one agent invocation — model, prompt version, tokens, cost, tools
  invoked, decision path, outcome, duration. The single store of the agent-run facts that 001's
  `AuditEntry` resolves through (FR-033, C-13).
- **PromptVersion**: an immutable, addressable prompt revision with template, parameters and model
  defaults. Defined as an entity in 001; this specification owns its registry, immutability and
  promotion rules.
- **TenantProviderConfig**: per-tenant model access — provider, region, permitted models, credential
  reference, data-residency flag, ownership (Healer-managed or customer-supplied).

**Concepts that are deliberately not persisted here.** Each would be a second store of a fact that
already exists somewhere (VIII):

- **RunnerRelease** — the published artifact *is* the record: an immutable image tag, its checksum in
  the registry and its entry in `docs/changelog.md` (FR-017). The control plane stores the range it
  supports as configuration, and what a tenant is actually running in `runner_registration`.
- **JobExecution** — attempts, retries and dead letters live in BullMQ, which is already observable;
  a wall-clock breach is recorded as a `workflow_transition` with cause `timeout` and surfaced
  (FR-027). A table would duplicate the queue.
- **PromptEvalResult** — owned by 011: the eval history of a prompt version is the set of 011 run
  reports and metrics whose run configuration pins that `prompt_version_id` (FR-040). Copying the
  outcome here is how the benchmark and the registry start disagreeing.
- **CiGate** — the enumeration is [contracts/make-targets.md](contracts/make-targets.md) plus the
  machine-readable result the gate harness emits per target (FR-016). "Which gates exist" is answered
  by the contract, not by a row.
- **ChatPost / ChatTask** — the Telegram message is the transport and the task line or issue it becomes
  is the work item (FR-061); the audit entry records the sender and the decision. A chat-task table
  would be a fourth copy of the task.
- **AgentTask** — the task line in `tasks.md` is the work item and the pull request is the record of
  its execution (FR-053). A table of agent tasks would be a third copy of both.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 gates exist in CI that cannot be run from a clean local checkout, and the local and
  CI verdicts agree for the same commit in 100% of sampled runs.
- **SC-002**: Adding a new module requires 0 edits to boundary lint configuration for the rules to
  apply, proven by a fixture module violating each forbidden pattern.
- **SC-003**: Each forbidden import pattern has a failing fixture, and 0 violations reach the default
  branch.
- **SC-004**: 0 difference between committed generated artifacts and freshly generated output, on
  every build.
- **SC-005**: 100% of HTTP endpoints have a tenant-isolation end-to-end test; an endpoint added
  without one fails the build (001 SC-004).
- **SC-006**: 100% of catalogued reversible actions have a test that exercises the undo (002 SC-005).
- **SC-007**: 0 job handlers contain a blocking wait, and job wall-clock stays within the declared
  maximum for 100% of executions, with any breach recorded.
- **SC-008**: 100% of workflow runs are reconstructable from persisted transitions alone, and
  reconstructing twice produces identical output (consistent with 001 SC-005).
- **SC-009**: 100% of agent runs resolve to a retrievable model identifier and prompt version, and
  reported spend for an issue equals the sum of its run records (001 SC-007).
- **SC-010**: A traced run's correlation identifier retrieves 100% of its jobs, agent calls, runner
  tasks, callbacks, evidence records and audit entries.
- **SC-011**: 0 planted secret or customer-content markers appear in logs, traces, metrics, outbound
  runner payloads or the support diagnostic bundle.
- **SC-012**: 0 payloads crossing the boundary fail ingress validation undetected; every rejection is
  counted and visible on both sides.
- **SC-013**: A runner **within** the supported range — up to two minor protocol versions behind the
  current one — operates, with read-only gaps degraded explicitly and every state-changing gap refused;
  a runner **below the floor** reports `incompatible`, is shown as unavailable in 100% of cases and
  executes 0 tasks (FR-018, C-02).
- **SC-014**: A simulated runner fault is resolved by Healer support using only the diagnostic bundle,
  with 0 requests for customer logs, source or data.
- **SC-015**: 100% of required configuration keys are validated at startup; a process with a missing
  required key starts 0 times.
- **SC-016**: 0 model requests for a customer-supplied-provider tenant reach the Healer-managed
  provider, including under induced provider failure.
- **SC-017**: 0 referenced prompt versions are mutated or deleted; resolving any historical audit
  entry's prompt version succeeds in 100% of cases.
- **SC-018**: A new developer reaches a passing test suite on a clean machine using only the
  documented commands, verified by an automated clean-image run on every release.
- **SC-019**: The vector index is rebuilt from Postgres in the test suite with 0 loss of retrievable
  content.
- **SC-020**: 100% of agent-authored pull requests reference a task identifier and passed the gate
  command before review was requested.
- **SC-021**: 0 agent-authored change sets touching a protected path or a pre-existing test assertion
  reach the default branch; each protected-path category has a fixture change set the scope gate
  refuses.
- **SC-022**: 100% of agent-authored behavioural change sets contain a test that fails against the
  base revision, and 0 agent credentials hold merge permission.
- **SC-023**: 0 chat posts from a sender outside the allowlist cause a task, signal or job, and 100% of
  them are audited; 0 chat findings start an agent job as a task; 100% of agent jobs started from the
  channel report an outcome back to it.

## Assumptions

- This specification owns the build, the boundaries, the gates, the runner's packaging and transport
  contract, workflow execution mechanics, self-observation plumbing, the prompt registry,
  configuration and the storage conventions. It does **not** own: evidence semantics and the audit
  record's content (001), policy decisions and budgets (002), what is collected and how it is
  redacted on the customer side (003), sandbox isolation internals (007), benchmark methodology and
  scoring (011), or agent behaviour (006, 008). Where a gate here enforces a rule, the rule's meaning
  belongs to the specification that defined it.
- The runner's diagnostic surface is designed against the support model where Healer never sees
  customer data. If a customer voluntarily shares logs during an incident, that is their decision and
  is out of scope — no Healer code path may depend on it.
- Coverage floors, the job wall-clock maximum, the heartbeat threshold, the offline buffer bound and
  the CI wall-clock budget are configuration with starting values set during planning, expected to be
  tuned. They are not constants in code.
- "No Kubernetes or Terraform" (FR-052) constrains Healer's own development and control-plane
  deployment. Customers frequently run the runner on Kubernetes; the runner's packaging must not
  assume otherwise, which is the subject of the clarification below.
- The observability stack named in the constitution is the v1 adapter set for reading a *customer's*
  telemetry (003). Healer's own tracing under FR-032 to FR-037 is a separate concern and shares only
  the correlation identifier convention.
- Agent-driven development (FR-053 to FR-059) names no coding-agent product. Its controls live in the
  repository, the gates and the version-control permissions, so they hold for any agent — and for a
  future Healer runner pointed at this repository. It presumes the repository is under version control
  with a CI system that reports authenticated author identity; until both exist, no agent-authored
  change set can satisfy FR-054, and agent work stays local and human-committed.
- The chat channel (FR-060..FR-065) is Telegram first and one channel per project (C-48). Other
  platforms are adapters of the same intake and report path; Slack is revisited before the channel
  faces customers. It names no new authority: it is a consumer of the REST surface and of ADR 0011's
  pipeline.
- Gate enforcement assumes the change set is inspectable at build time (FR-006, FR-015). On a build
  where that is unavailable, the gate must fail closed rather than pass by default.
- **The container image and its contract are the runner product** — environment, health, protocol
  version, resource expectations. Exactly one deployment wrapper ships in v1 — Docker Compose (C-39) —
  matching what the design partner actually runs; a second wrapper is built when a customer needs it, not in advance.
  The upgrade and rollback path in FR-019 is defined against the image, so it holds regardless of
  which wrapper is added later.
- **Version divergence is handled by capability handshake, not by a single reject-or-degrade rule.**
  The runner declares the capabilities it supports. Read-only paths — evidence collection, diagnosis
  — degrade explicitly and record which capability was missing. Any path that changes state — patch
  application, remediation, repository write — is refused with the reason, never silently degraded,
  because a mutation executed by older logic without warning is exactly the failure this product
  cannot have. Below a hard floor of two minor versions or ninety days, whichever is reached first,
  the control plane refuses entirely and reports the required upgrade.
