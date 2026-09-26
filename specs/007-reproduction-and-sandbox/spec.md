# Feature Specification: Reproduction engine and isolated execution

**Feature Branch**: `007-reproduction-and-sandbox`

**Created**: 2026-09-23

**Status**: Draft

**Input**: No code change without a failing reproduction first. Climb the reproduction ladder from cheapest to most expensive, stop at the first rung that reproduces, and say `INCONCLUSIVE` honestly when nothing does — executing the customer's test suite and model-generated code inside an isolated sandbox in the customer's own infrastructure, with default-deny egress and no production credentials.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Nothing is modified until something fails (Priority: P1)

Diagnosis says a null reaches a handler that promised a non-null response. Before any file is
touched, Healer constructs a unit-level reproduction, runs it in the sandbox, and gets a failure
whose signature matches the issue. Only then does the change path open. If the reproduction passes
instead, the diagnosis is wrong and the fix path never opens.

**Why this priority**: constitution III. A diagnosis is a hypothesis; a failing reproduction is the
first piece of evidence that the system's understanding matches reality, and it is produced by
execution rather than by a model. Without it every downstream gate is verifying a story.

**Independent Test**: for a seeded issue with a known defect, the engine produces a reproduction
that fails on the affected commit and passes on the fixed commit, and the change path is refused
when no `FAIL` result exists.

**Acceptance Scenarios**:

1. **Given** a diagnosis with a reproduction directive, **When** the reproduction runs and the
   observed failure signature matches the issue's normalised signature, **Then** the result is
   `FAIL` (reproduced) and the change path becomes eligible.
2. **Given** a reproduction that runs cleanly, **When** it completes, **Then** the result is `PASS`
   (not reproduced), the change path stays closed, and the diagnosis is marked as unconfirmed by
   execution.
3. **Given** no reproduction with result `FAIL` exists for an issue, **When** a code change is
   proposed, **Then** it is refused, and no path exists that can bypass the check.
4. **Given** a reproduction fails for a reason unrelated to the issue — a missing dependency, a
   broken build — **Then** the result is `INCONCLUSIVE`, never `FAIL`; a failure that is not *the*
   failure is not a reproduction.

---

### User Story 2 - The ladder, cheapest rung first (Priority: P1)

The engine tries a deterministic unit-level reproduction first. It takes four seconds and
reproduces. It stops there. It does not boot the application, does not construct a load test, does
not go looking for production data. A different issue reaches rung four, fails to reproduce under
concurrency after the attempt budget, and returns `INCONCLUSIVE` with every rung's outcome
recorded.

**Why this priority**: reproduction cost dominates the economics of the loop, and the rungs differ
by orders of magnitude in time and risk. The cheapest rung that reproduces is also the rung whose
result is most trustworthy and whose fixture is least likely to contain customer data.

**Independent Test**: seed issues designed to reproduce at each rung → for every one, the engine
stops at the correct rung and no higher rung is attempted.

**Acceptance Scenarios**:

1. **Given** an issue reproducible at the unit-level rung, **When** the engine runs, **Then** it
   stops at that rung and no more expensive rung is attempted.
2. **Given** an issue requiring a specific data shape, **When** cheaper rungs do not reproduce,
   **Then** the engine climbs to the data rung and records why each cheaper rung was rejected.
3. **Given** a rung is skipped because its preconditions are unavailable — no load harness, no
   concurrency entry point — **Then** the skip and its reason are recorded, not silently omitted.
4. **Given** the per-issue reproduction budget is exhausted mid-ladder, **When** the next rung is
   requested, **Then** it is refused per 002 FR-011 and the result is `INCONCLUSIVE` with the ladder
   state preserved.

---

### User Story 3 - "I could not reproduce this" is an answer (Priority: P1)

A race condition does not reproduce after the attempt budget. The engine returns `INCONCLUSIVE` and
hands a human the rungs attempted, the timings, what was ruled out, and the hypotheses that survive.
The engineer starts from the third hour of work, not the first.

**Why this priority**: constitution III names `INCONCLUSIVE` a first-class outcome. A system that
never says it could not reproduce something is a system that guesses, and concurrency and
load-dependent classes are a large share of real incidents (`research/wiki/incident-taxonomy.md`).
Repeated failure is output, not only cost.

**Independent Test**: run the engine against a known non-reproducible incident → `INCONCLUSIVE`
with a populated ladder record, no fix path opened, and a human handoff containing the accumulated
evidence.

**Acceptance Scenarios**:

1. **Given** no rung reproduces within the budget, **When** the engine completes, **Then** the
   result is `INCONCLUSIVE` and the issue routes to a human rather than to a failure state.
2. **Given** an `INCONCLUSIVE` result, **When** the handoff is read, **Then** it contains every rung
   attempted with its outcome, resource cost, and the rejected hypotheses from diagnosis.
3. **Given** an `INCONCLUSIVE` result, **When** a change is proposed, **Then** it is refused for the
   same reason a `PASS` refuses it.
4. **Given** a failure observed in some runs but not all, **When** the result is recorded, **Then**
   it is `FAIL` with an intermittent flag and the observed rate, and the intermittency is carried
   forward so that 008 cannot use it as the sole proof of a fix.

---

### User Story 4 - The sandbox is hostile to what it runs (Priority: P1)

The sandbox executes the customer's test suite and model-written code in the customer's own
infrastructure. It has no production credentials, no network egress, a wall-clock limit, and a
workspace that is destroyed when the run ends. A test that tries to reach the internet fails at the
syscall — there is no route to deny it with — and the run records that there was none.

**Why this priority**: this component runs untrusted code — model-generated, and a test suite whose
inputs are attacker-influenceable — with access to the customer's source tree. Default-deny egress
matters more in practice than container escape: a test suite with internet access can exfiltrate the
repository, quietly (`research/wiki/security-posture.md`).

**Independent Test**: run a deliberately hostile fixture that attempts egress, credential access,
fork bombing and a hang → every attempt is denied or bounded, the run terminates within limits, and
the run record carries the egress posture, the prefetch denials and every bound that fired.

**Acceptance Scenarios**:

1. **Given** code in the run container attempts a network connection, **When** it runs, **Then** the
   connection fails because there is no route and no resolver, the failure surfaces in the runner
   output the adapter already parses, and the run's recorded egress posture states that the route
   table was empty and the resolver absent. A prefetch-phase attempt to a destination outside the
   allowlist is denied at the proxy and recorded as an `egress_denial` on the run.
2. **Given** a sandbox run, **When** its environment is inspected, **Then** no production
   credential, repository write credential or tenant secret is present.
3. **Given** a test that never terminates, **When** the wall-clock limit is reached, **Then** the
   process tree is killed and the result is `TIMEOUT`, which is `INCONCLUSIVE` — never `PASS`.
4. **Given** a run completes or fails, **When** the workspace is inspected afterwards, **Then** it
   no longer exists, and the next run for the same tenant starts from a fresh workspace.
5. **Given** two tenants run concurrently, **When** either inspects its filesystem, cache or
   execution records, **Then** nothing belonging to the other tenant is reachable.

---

### User Story 5 - Reproducing a data bug without taking the data (Priority: P2)

One malformed row crashes a report. Healer reproduces it from the *shape* of the failing input —
field presence, types, length, encoding — synthesised into a fixture. The production row never
leaves the customer's database, and nothing resembling it is persisted in a fixture.

**Why this priority**: data-specific bugs are a real class and their reproduction is where a
well-intentioned system accidentally builds a PII pipeline. The position has to be explicit before
the first data-rung reproduction runs, not after a procurement review asks.

**Independent Test**: reproduce a seeded data-specific defect with a fixture derived from request
shape only → the defect reproduces, and a scan of the fixture finds no value copied from the source
record.

**Acceptance Scenarios**:

1. **Given** a data-specific issue, **When** a fixture is constructed, **Then** the engine attempts
   in order: reproduction from request shape without payload; synthetic data generated to satisfy
   the failing constraint; anonymised extract — and stops at the first that reproduces.
2. **Given** an anonymised extract is required, **When** it is requested, **Then** it proceeds only
   with an explicit tenant grant recorded in policy, and the transformation is irreversible.
3. **Given** a candidate fixture, **When** it is persisted, **Then** it is scanned for secret and
   personal-data patterns, and detection blocks persistence.
4. **Given** a raw production payload, **When** anything attempts to copy it into a fixture,
   **Then** the attempt is refused.

---

### User Story 6 - Running an arbitrary project's tests (Priority: P2)

A new repository arrives. Healer discovers how its tests are invoked, runs a subset, and turns the
runner's output into structured results — names, files, statuses, durations, failure messages. When
it cannot, it says so instead of guessing.

**Why this priority**: "run the tests and read the output" is an entire component, not a line item.
Every unparseable output that degrades to "looks fine" becomes a false `PASS`, which is the most
expensive lie this system can tell.

**Independent Test**: point the adapter at repositories with differing runner configurations →
tests are discovered, invoked and parsed into identical structured shapes; a repository with an
unsupported runner yields an explicit unsupported result, never a `PASS`.

**Acceptance Scenarios**:

1. **Given** a repository with a supported runner, **When** discovery runs, **Then** the test
   command, working directory and result format are resolved and recorded.
2. **Given** runner output that cannot be parsed, **When** the run completes, **Then** the result is
   `INCONCLUSIVE` with the parse failure as evidence, never `PASS`.
3. **Given** a repository whose runner is not supported by any adapter, **When** the tenant has
   declared a test command in configuration, **Then** that command is used; absent it, the result is
   `INCONCLUSIVE` naming the missing configuration.
4. **Given** a run exits non-zero with no parseable test results, **When** it is recorded, **Then**
   it is distinguished from a run with parsed failing tests.

---

### User Story 7 - The expensive tests run somewhere else (Priority: P3)

Fast unit tests run in the sandbox in seconds. The full suite and end-to-end tests are handed to the
customer's CI, which has the credentials, the services and the data. Healer records a persisted
state and waits for a callback — no job sits blocking on a twenty-minute pipeline.

**Why this priority**: D-16 and constitution VI. Delegating removes most of the secrets problem from
the sandbox, and the callback pattern is what keeps BullMQ sufficient instead of needing a workflow
engine (D-22).

**Acceptance Scenarios**:

1. **Given** a suite classified as beyond sandbox scope, **When** it is required, **Then** the
   system triggers the customer's CI, persists a waiting state, and no worker job blocks on the
   result.
2. **Given** CI completes, **When** the callback arrives, **Then** the results are ingested as
   evidence and correlated to the execution that requested them.
3. **Given** the callback never arrives, **When** the configured deadline passes, **Then** the state
   becomes a recorded timeout that routes to a human, not an indefinite wait.
4. **Given** a duplicate callback, **When** it is received, **Then** it does not double-apply.

---

### Edge Cases

- The commit the issue occurred on no longer exists — force-pushed or branch deleted → reproduction
  is `INCONCLUSIVE` with the reason, and the correlated deploy evidence is preserved.
- The build fails at the target commit → distinguished from a failing test; the result is
  `INCONCLUSIVE` with the build output as evidence, and the change path stays closed.
- Environment cannot be made reproducible — floating dependency versions, no lockfile → the run
  records the resolved versions actually used, so a later re-run that behaves differently is
  explainable rather than mysterious.
- The reproduction reproduces a *different* failure than the issue's signature → recorded as a
  distinct finding, `INCONCLUSIVE` for this issue, and surfaced: it may be a second bug.
- A test suite mutates shared state outside the workspace — writes to a mounted path, a shared
  cache → filesystem isolation denies it; the denial is recorded rather than silently tolerated.
- Sandbox capacity is exhausted for a tenant → runs queue with a bounded wait; the queue depth is
  observable and the wait is a persisted state, not a blocked job.
- Model-generated reproduction code attempts to invoke a tool or reach the control plane → refused;
  the sandbox has no path to the control plane other than the structured result contract.
- A run is retried after an infrastructure failure → it receives a new execution identifier; results
  are never merged across identifiers.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST require a reproduction with result `FAIL` before any code modification for
  that issue. No execution path may reach the change engine (008) without one.
- **FR-002**: System MUST implement **two** reproduction ladders and MUST select one by the
  directive's `observableLocation` (006 FR-017a), never by the issue's kind. The **server** ladder is
  deterministic unit-level, deterministic request-level, data-specific, concurrency, load, external
  state. The **client** ladder is component-level, recorded-request replay, and browser journey. It
  MUST attempt rungs cheapest first **within the selected ladder** and MUST stop at the first rung
  that reproduces.
- **FR-002a**: A symptom observable only in a browser MUST NOT be attempted on the server ladder, and
  the reverse likewise — `unit` and `request` cannot produce a `FAIL` for a client-only observable in
  principle, so attempting them would waste two rungs by construction. An `observableLocation` of
  `undetermined` MUST yield `INCONCLUSIVE` with reason `observable_location_undetermined` rather than a
  guessed browser run.
- **FR-002b**: The browser rung MUST require a declared reason and MUST be refused when a cheaper rung
  on its ladder was never attempted. It needs the customer's frontend build, browsers in the runner
  image and a locally served application against a local or stubbed backend, since the sandbox has
  default-deny egress — it is the most expensive operation in the product and MUST NOT be reachable by
  omission.
- **FR-003**: Every rung attempted MUST be recorded with its outcome, duration and resource cost.
  Every rung skipped MUST be recorded with the reason it was skipped.
- **FR-004**: Reproduction result MUST be one of `PASS`, `FAIL` or `INCONCLUSIVE`. `FAIL` means the
  reported failure was reproduced; `PASS` means it was not; `INCONCLUSIVE` means it could not be
  determined.
- **FR-005**: A `FAIL` result MUST require that the observed failure signature matches the issue's
  normalised error signature (001 FR-002, 001 FR-003). A failure of a different kind MUST yield
  `INCONCLUSIVE` and MUST be surfaced as a possible separate defect.
- **FR-006**: `INCONCLUSIVE` MUST route to a human with the accumulated evidence, the ladder record
  and the rejected hypotheses from diagnosis (006). It MUST NOT be represented as a system error.
- **FR-007**: A reproduction MUST be run more than once where the class permits. A failure observed
  in some runs but not all MUST be recorded as intermittent with its observed rate, and the
  intermittency flag MUST be carried to 008.
- **FR-008**: The reproduction assertion MUST derive from the issue's evidence — the observed error
  signature, the violated contract, or an adopted `ExpectedBehavior` — and MUST NOT derive from the
  diagnosis narrative alone (constitution II).
- **FR-009**: All execution MUST occur inside a sandbox running in the customer's execution plane
  (D-02). Model-generated code MUST NOT execute anywhere else.
- **FR-010**: The sandbox MUST enforce container isolation with limits on CPU, memory, process
  count, open files, disk and wall-clock time, and MUST kill the entire process tree on limit
  breach.
- **FR-011**: The sandbox MUST apply default-deny network egress. The **run container MUST have no
  egress configuration at all** — no default route and no resolver — so there is nothing to
  misconfigure and no run-time allowlist to widen. Any allowlisted destination MUST be explicit, MUST
  belong to a versioned sandbox profile, and MUST apply only to the prefetch phase at image-build
  time. A denied attempt in the prefetch phase MUST be recorded on the run; for the run container the
  recorded fact is the **absent route** — empty route table, absent resolver, allowlist digest — on
  the execution record, because an absent route produces no denial event to capture (R-19).
- **FR-012**: The sandbox MUST contain no production credentials, no repository write credentials
  and no tenant secrets. Credential presence MUST be checked automatically on every run.
- **FR-013**: Each run MUST have an immutable execution identifier, and every artefact, log and
  evidence record produced MUST reference it. Retried runs MUST receive a new identifier and MUST
  NOT merge results.
- **FR-014**: The workspace MUST be destroyed after each run, including on failure and on timeout,
  and a run MUST start from a fresh workspace.
- **FR-015**: The sandbox MUST check out the exact commit correlated to the issue, record the
  resolved commit identifier, and record the resolved dependency versions and base image digest so
  that the environment is reconstructible.
- **FR-016**: A run that times out MUST be recorded as `TIMEOUT` and mapped to `INCONCLUSIVE`. A
  timeout MUST NEVER be recorded as `PASS`.
- **FR-017**: A build or environment failure MUST be distinguished from a test failure, and MUST
  yield `INCONCLUSIVE` with the failing output as evidence.
- **FR-018**: System MUST provide test-runner adapters that discover a project's test command and
  working directory, invoke a targeted subset or the whole suite, and parse runner output into
  structured results containing test identifier, file, status, duration and failure detail.
- **FR-019**: Unparseable or absent runner output MUST yield `INCONCLUSIVE` with the parse failure
  as evidence. It MUST NEVER yield `PASS`.
- **FR-020**: When no adapter supports a repository, the system MUST use a tenant-declared test
  command from configuration; if none exists, the result MUST be `INCONCLUSIVE` naming the missing
  configuration.
- **FR-021**: Fast unit-scope tests MUST run in the sandbox. Full-suite and end-to-end execution
  MUST be delegated to the customer's CI (D-16).
- **FR-022**: CI delegation MUST be implemented as a persisted waiting state plus an inbound
  callback. No job may block waiting for CI (constitution VI). Callback handling MUST be idempotent,
  and a callback that never arrives MUST become a recorded timeout routed to a human.
- **FR-023**: CI results MUST be ingested as evidence records (001 FR-007) correlated to the
  execution that requested them, carrying the CI run identifier.
- **FR-024**: Fixture construction for data-specific reproduction MUST attempt, in order:
  reproduction from request shape without payload; synthetic data generated to satisfy the failing
  constraint; anonymised extract under an explicit, recorded tenant grant. Raw production payloads
  MUST NOT be copied into fixtures under any mode.
- **FR-025**: Every persisted fixture MUST be scanned for secret and personal-data patterns before
  storage, and detection MUST block persistence and raise the finding.
- **FR-026**: Only structured results MUST cross the execution/control plane boundary — test
  results, exit codes, normalised failure signatures, file paths, durations, resource usage, denial
  records. Raw log bodies, source files and fixture payloads MUST NOT cross.
- **FR-027**: Reproduction MUST respect the per-issue budget and attempt caps (002 FR-011,
  002 FR-013), and MUST return `INCONCLUSIVE` with the preserved ladder state on exhaustion.
- **FR-028**: Agents MUST NOT have raw shell access to the sandbox. Execution is requested through
  declared, schema-validated, permission-checked and audited tools (constitution security model).
- **FR-029**: Every run MUST emit its own evidence links as it runs (001 FR-008), and MUST produce
  an audit entry per 001 FR-012.
- **FR-030**: Every execution record, workspace, cache, image and fixture MUST carry `tenantId` and
  be isolated per tenant; no writable state may be shared across tenants. A read of another tenant's
  execution MUST return not-found (001 FR-015).
- **FR-031**: Per-rung repeat counts MUST have a product **floor** that tenant configuration cannot
  cross, established as a literal alongside a constant in code with a test asserting they agree. A repeat
  count of one makes a single flaky `PASS` a reproduction, and everything downstream — the regression test,
  the fix verdict, the false-fix rate — is anchored on it ([stage 0 S0-7](../../docs/stage-0.md)).

### Key Entities

- **ReproductionAttempt**: issue, diagnosis version, ladder record, final result
  (`PASS` | `FAIL` | `INCONCLUSIVE`), intermittency flag and rate, budget consumed, human handoff
  reference when inconclusive.
- **LadderRung**: rung identifier and order, outcome (`reproduced` | `not_reproduced` | `skipped` |
  `error`), reason, duration, resource cost, execution identifier.
- **ExecutionRun**: immutable execution identifier, tenant, commit, base image digest, resolved
  dependency versions, declared limits, observed resource usage, exit status, recorded egress posture
  (empty route table, absent resolver, allowlist digest), prefetch-phase egress denials, workspace
  lifecycle timestamps.
- **SandboxProfile**: limits (CPU, memory, processes, disk, wall clock), prefetch-phase egress
  allowlist, mounted paths, credential policy. Versioned; a run records the profile version used.
- **TestRunnerAdapter**: discovery result — runner identity, command, working directory, output
  format — plus the parser that produces structured results.
- **TestResult**: test identifier, file, status, duration, failure message, failure signature,
  execution identifier.
- **ReproductionFixture**: rung, construction mode (`request_shape` | `synthetic` | `anonymised`),
  `content_digest`, `recipe` (field shapes or generator parameters and seed — null for `anonymised`),
  `scan_result`, tenant grant reference when anonymised. **No contents and no retention state**:
  nothing is retained, so there is no state to hold (C-04, R-06).
- **CiDelegation**: requested suite scope, external run identifier, persisted waiting state,
  deadline, callback receipts, ingested results.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 code modifications occur for an issue without a recorded `FAIL` reproduction,
  verified continuously by reconciling change plans against reproduction results.
- **SC-002**: In 100% of successful reproductions, no rung above the reproducing rung was attempted.
- **SC-003**: 0 sandbox runs reach a network destination outside the configured allowlist, verified by
  a red-team fixture in CI and, in production runs, by two records: the recorded egress posture on
  every execution record showing the run container had no route and no resolver, and the prefetch
  phase's denial records. The check is over the absent route, not over captured syscalls (R-19).
- **SC-004**: 0 sandbox runs contain a production credential, repository write credential or tenant
  secret, verified by an automated pre-run and post-run scan.
- **SC-005**: 100% of sandbox workspaces are destroyed within the configured grace period after run
  end, including runs that failed or timed out, verified by a reconciliation job.
- **SC-006**: 0 runs with unparseable runner output, a timeout, or a build failure are recorded as
  `PASS`.
- **SC-007**: For deterministic issue classes, repeating a reproduction at the same commit yields
  the same rung and the same result in at least 99% of repeats.
- **SC-008**: The share of golden-dataset incidents reproducible at any rung is measured and
  reported per release — this is the number that sizes the product (stage 0, S0-1) and a fall below
  the threshold set there is a scope signal, not a bug.
- **SC-009**: 0 raw log bodies, source files or fixture payloads cross the execution/control plane
  boundary, verified by a contract test on the boundary schema.
- **SC-010**: 0 persisted fixtures contain a value copied from a production record, verified by the
  fixture scanner and by a sampling audit.
- **SC-011**: 0 worker jobs block on customer CI; the longest job duration stays within the limit
  defined in the plan under an induced slow-CI test.
- **SC-012**: 0 cross-tenant reads of executions, workspaces, caches or fixtures succeed in the
  isolation test matrix.

## Assumptions

- This specification owns reproduction and isolated execution only. It does not own diagnosis (006),
  writing or verifying a fix (008), the policy engine and budgets (002), evidence storage (001) or
  the CI system itself. It consumes a reproduction directive from 006 and produces a reproduction
  result plus execution evidence for 008.
- Ladder rung boundaries follow `research/wiki/incident-taxonomy.md`. Rung attempt limits, repeat
  counts for intermittency detection and wall-clock ceilings are configuration tuned on the stage-0
  incident audit, not constants.
- The PII position is decided, not open: request-shape reproduction first, synthetic data second,
  anonymised extract only under an explicit recorded tenant grant, raw production payloads never.
  This is a product commitment that appears in the DPA, so relaxing it is a contract change rather
  than a configuration change.
- **Healer retains no reproduction fixtures.** The workspace, including any anonymised extract, is
  destroyed when the run ends. Where a regression test needs fixture data, that data is committed to
  the customer's repository with the test in the pull request (008) — it lives where their test data
  already lives, under their retention and their review. Re-verification later re-runs their test
  from their repository. Consequence: zero derived customer data at rest in Healer, and no fixture
  retention clause in the DPA.
- The v1 adapter set covers one stack (constitution VII); unsupported repositories degrade to a
  tenant-declared test command rather than to a guess.
- Stronger isolation technology than container isolation is expected where tenants share hardware;
  the requirements here state the properties, and the mechanism is a plan-level choice.
- Sandbox capacity is finite per tenant and queuing is expected; the queue is a persisted state with
  observable depth, consistent with "never wait inside a job".
