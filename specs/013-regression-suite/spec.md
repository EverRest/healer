# Feature Specification: Regression suite — adopted expectations become tests, and a failing test becomes an issue

**Feature Branch**: `013-regression-suite`

**Created**: 2026-09-26

**Status**: Draft

**Input**: Regression testing that runs the way fixes and development already run. Scenarios for every page and every API are drafted by Healer, adopted by a human, turned into tests by an agent, merged by a human, run by the customer's CI on every change and on a schedule — and a failure enters the same investigation pipeline as any other issue.

## Clarifications

### Session 2026-09-26

- Q: Where do scenarios live, and what adopts one? → A: 005's repository markdown, the only text
  source in v1 (C-06); adoption is a human's approval of the pull request that adds or changes the
  document (005 R-16). The "wiki" of scenarios is that directory — reviewed like code.
- Q: How does the customer's CI learn which tests a pull request needs? → A: a CI step sends the
  changed paths to Healer and receives test paths back — paths only cross (012 FR-022). If Healer is
  unreachable the step selects the full suite: selection may widen, never narrow.
- Q: How do results of runs Healer did not request (schedule, post-deploy, a person's pull request)
  arrive? → A: the CI host's pipeline event reaches Healer; a collection directive sends the runner to
  fetch the machine-readable report, parsed by 007's adapters (007 R-10) into `test_result`. Report
  contents stay in the customer's network.
- Q: What is a regression's fingerprint? → A: the binding identifier plus environment, as a new
  version of 001's normalisation ruleset — one test failing repeatedly is one issue.
- Q: Starting values? → A: 25 open draft expectations per component; more than 10 failing bound tests
  in one run group into one incident. Both are set in planning to fail closed and tuned from S0-5.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Only an adopted expectation becomes a test (Priority: P1)

An engineer adopts twelve expectations for checkout. Healer's test author writes one test per
expectation, each naming the expectation and the adopted version it asserts, and opens a pull request
in the customer's repository. A human merges it. The eighty drafts nobody adopted produce no test at
all.

**Why this priority**: Principle II. A model that reads the code and describes what it does writes
down today's behaviour, bugs included, and a test built from that description protects the bug. The
only thing that makes a regression suite a judge rather than a mirror is that every assertion traces
to an expectation a human adopted (005 FR-010, FR-011). This is 008 FR-006 applied to the suite.

**Independent Test**: request a test for a `draft` expectation → refused; adopt it → a test is written
whose binding resolves to that exact adopted version; edit the expectation without re-adopting → the
test stays bound to the adopted version.

**Acceptance Scenarios**:

1. **Given** an expectation in state `draft` — its pull request not yet approved by a human —
   **When** a test is requested for it, **Then** the request is refused and the refusal is recorded.
2. **Given** an adopted expectation with structured constraints (005 FR-014), **When** the test author
   writes its test, **Then** the test's assertions reference those constraints, and a test with no
   assertion referencing a constraint of its expectation is refused as vacuous.
3. **Given** a written test, **When** its pull request is opened, **Then** it passed against the
   default branch in the sandbox, and the pull request names the expectation, the adopted version and
   the adopting human.
4. **Given** a written test that fails against the default branch, **When** the author finishes,
   **Then** no test pull request is opened; an issue of kind `automated_detection` is raised carrying
   the expectation and the failing result — the system already violates what a human adopted.
5. **Given** a test pull request, **When** merge is attempted, **Then** it requires a human; Healer
   never merges (L2).

---

### User Story 2 - Every change runs the scenarios it can affect (Priority: P1)

A pull request — from a person or from Healer — touches the pricing module. The customer's CI runs the
regression tests bound to every component in the change's impact closure, plus every journey through
those components. A change whose impact cannot be computed runs the whole suite.

**Why this priority**: a suite that runs nightly finds the regression a day after it merged. Selection
is what makes running on every change affordable, and selection is only safe if it can widen and never
narrow.

**Independent Test**: change a file whose component sits under three bound expectations → exactly
those tests and the journeys through the component are selected; make the impact closure
uncomputable → the full suite is selected.

**Acceptance Scenarios**:

1. **Given** a change set, **When** tests are selected, **Then** the selection is derived from 004's
   impact closure and includes every test bound to a component in it — the closure has no confidence
   parameter, so an unconfirmed edge adds tests and never removes them (C-03).
2. **Given** a change touching a component on a user flow, **When** tests are selected, **Then** that
   flow's journey test is included (C-28).
3. **Given** an impact closure that cannot be computed, **When** tests are selected, **Then** the full
   suite is selected and the reason is recorded.
4. **Given** a selected run, **When** it completes, **Then** its results reach Healer as `test_result`
   shapes through the CI adapter, never as logs.

---

### User Story 3 - A failing scenario is an issue, and goes where every issue goes (Priority: P1)

The nightly run fails `checkout-014`: a discount is applied twice. Healer opens an issue of kind
`regression`, with the failing result, the last passing commit and the commit range as evidence. It is
classified, reproduced and — where policy allows — fixed exactly as an alert would be. The expectation
that the test asserts is already adopted, so the fix has its anchor before anyone looks at it.

**Why this priority**: this is the point of the feature. A regression suite whose failures land in a
separate report is a second queue that nobody triages. One pipeline means one triage, one evidence
model, one audit trail (001 US3, "one pipeline for every source").

**Independent Test**: make a bound test fail on the default branch → one `regression` issue is
created, deduplicated across reruns, with the test result and commit range as evidence, and 008 finds
its anchor without a human choosing one.

**Acceptance Scenarios**:

1. **Given** a bound test that passed at commit A and fails at commit B on the default branch,
   **When** the result is received, **Then** an issue of kind `regression` is created with the test
   result, both commits and the commit range as evidence (001 FR-007).
2. **Given** the same test failing in five consecutive runs, **When** results are received, **Then**
   they group into one issue by fingerprint (001), not five.
3. **Given** a `regression` issue, **When** it reaches 008, **Then** the anchor is the expectation
   version the failing test is bound to, and 008's own rules decide eligibility — this feature grants
   nothing.
4. **Given** a test failing only on a pull request branch, **When** the result is received, **Then**
   no issue is created; the failure is the pull request's, reported there by the customer's CI.

---

### User Story 4 - Drafts for every page and every API, without drowning the reviewer (Priority: P2)

Healer drafts expectations for every documented API operation from the OpenAPI description, with no
model call, and drafts page and journey expectations from routes, components and existing end-to-end
tests with a model. Drafts are delivered in reviewable batches, capped per component, ranked by where
incidents actually happen.

**Why this priority**: the bottleneck is not generation, it is adoption. A thousand drafts nobody reads
is the same as none, and worse, because it looks like coverage.

**Independent Test**: seed a service with an OpenAPI description of 40 operations → drafts cover every
operation and documented response code with zero model calls; seed a component with 200 candidate page
drafts → no more than the cap is open for review at once.

**Acceptance Scenarios**:

1. **Given** an OpenAPI description, **When** drafting runs, **Then** every operation and every
   documented response code has a draft, produced deterministically without a model call, and drafts
   reach the engineer as a pull request against the expectation documents — approving it is adoption
   (005 R-16), editing it before approval is how an engineer corrects a draft.
2. **Given** page and journey drafting, **When** a model proposes drafts, **Then** each is
   `machine_generated`, `draft`, with its seeding sources recorded (005 FR-007, FR-022), and none is a
   test until adopted.
3. **Given** a component with open drafts at the cap, **When** drafting runs again, **Then** no new
   drafts are opened for it until some are adopted or discarded.
4. **Given** drafts across components, **When** a batch is offered for review, **Then** it is ordered
   by incident history and blast radius, not by generation order.

---

### User Story 5 - Coverage shows the gaps, including the ones that look covered (Priority: P2)

An engineer opens the coverage view for checkout: eleven endpoints, nine with adopted expectations,
seven with tests, one test quarantined. The quarantined one counts as uncovered.

**Why this priority**: without a coverage map, "we have a regression suite" is unfalsifiable.

**Independent Test**: bind tests to a subset of endpoints and quarantine one → the view reports each
endpoint's state, and the quarantined one is reported uncovered.

**Acceptance Scenarios**:

1. **Given** a component, **When** coverage is read, **Then** every endpoint and page 004 knows is
   listed as one of: no expectation · draft only · adopted, no test · tested · tested and quarantined.
2. **Given** a quarantined test (008 FR-013), **When** coverage is computed, **Then** it counts as
   uncovered until it is stable again.

---

### User Story 6 - A deliberate behaviour change is a human decision, not a red build (Priority: P3)

Product decides a discount can now stack. The test asserting it cannot starts failing on the pull
request that implements the change. The engineer edits the expectation, adopts the new version, and
Healer rewrites the test against it. Neither Healer nor the pull request author can make the old test
pass by editing it.

**Why this priority**: otherwise the suite either blocks every intended change or teaches people to
delete tests.

**Acceptance Scenarios**:

1. **Given** an adopted expectation changes version, **When** the new version is adopted, **Then** the
   bound test is marked stale and a test pull request against the new version is produced.
2. **Given** a change set that edits a bound test's assertion while its expectation version is
   unchanged, **When** it is inspected, **Then** it is flagged as a masking candidate (008 FR-014) and
   requires human approval.
3. **Given** code, expectation and observed behaviour disagree, **When** detected, **Then** it is a
   `KnowledgeDrift` routed to a human (005 FR-016, FR-017), never resolved automatically.

---

### Edge Cases

- An expectation is retired (005 FR-013) → its bound test is removed by a test pull request; until it
  merges the test's failures create no issues.
- A test is flaky → it is quarantined per 008 FR-013; its failures create no issues and it counts as
  uncovered; three quarantines of the same test route it to a human.
- A test fails because the environment is broken, not the product (CI runner out of disk, dependency
  down) → the issue is created and 006 classifies it `NOT_A_CODE_PROBLEM`; the suite does not guess.
- The whole suite fails at once → one issue per fingerprint, and a fan-out above a bound is grouped into
  a single incident rather than hundreds of issues.
- The test author cannot write a test that satisfies the constraint (the behaviour is not observable
  at any rung) → it records `NOT_TESTABLE` with the reason; the expectation stays adopted and uncovered.
- A journey requires credentials or third-party services → it runs against stubs in the sandbox
  (default-deny egress); a journey that needs the real service is not written, and is reported.
- The customer edits an expectation document by hand → merged through an approved pull request, that
  is adoption (C-06) and the bound tests go stale (FR-020); pushed without an approving review, 005
  does not adopt it.
- OpenAPI and code disagree about a response code → the draft is produced from OpenAPI and a
  `KnowledgeDrift` is raised; neither side wins silently.

## Requirements *(mandatory)*

### Functional Requirements

**Scenarios are expectations**

- **FR-001**: A regression scenario MUST be an `ExpectedBehavior` (005). This feature MUST NOT
  introduce a second store of expected behaviour; it binds tests to expectations and nothing else.
- **FR-002**: Scenario content MUST live in 005's repository markdown format (005 R-08) under its
  configured path in the customer's repository — the only text source in v1 (C-06) — extended per
  expectation with a subject (endpoint, page or `flow` node), Given/When/Then and a priority, beside
  the constraints 005 already parses. Adoption MUST remain what 005 R-16 makes it: a human's approval
  of the pull request that introduces or changes the document; Healer's own identity can never be that
  approver (005 R-17).

**Drafting**

- **FR-003**: API drafts MUST be derived deterministically from OpenAPI descriptions — one per
  operation and documented response code — without a model call.
- **FR-004**: Page and journey drafts MAY be proposed by a model from routes, components, the product
  graph (004) and existing end-to-end tests. They MUST be `machine_generated` drafts with seeding
  sources recorded (005 FR-007, FR-022). Any model call over customer source MUST run in the runner
  (ADR 0010).
- **FR-005**: Drafts MUST be delivered as pull requests against the expectation documents, and open
  draft expectations MUST be capped per component; drafting for a component at its cap MUST NOT open
  new drafts. The cap ships a starting value chosen to fail closed (C-32).
- **FR-006**: Drafts offered for review MUST be ordered by incident history and blast radius (004).

**Test authoring**

- **FR-007**: A test MUST be written only for an expectation with an active `AnchorGrant` (005
  FR-010); a request for any other MUST be refused and recorded.
- **FR-008**: Every test MUST carry a binding to exactly one expectation identifier and adopted
  version. Its assertions MUST reference that version's constraints; a test with none MUST be refused
  as vacuous.
- **FR-009**: The test author MUST run in the runner (ADR 0010), MUST select the lowest rung of 007's
  ladders that can observe the expectation, and MUST reach `client_journey` only with a declared
  reason (C-25).
- **FR-010**: A written test MUST pass against the default branch in the sandbox before its pull
  request is opened. A test that fails there MUST NOT be proposed; an issue of kind
  `automated_detection` MUST be raised instead with the expectation and the result as evidence.
- **FR-011**: Tests MUST reach the repository only as pull requests merged by a human (L2); the test
  author's credentials MUST NOT permit merge.

**Running**

- **FR-012**: The suite MUST be executed by the customer's CI — on every pull request, on a schedule,
  and after a deploy to a declared environment. Healer MUST NOT execute the suite against a live
  environment.
- **FR-013**: For a pull request, Healer MUST provide the selection: every test bound to a component in
  004's impact closure of the change set, plus every journey test through those components. An
  uncomputable closure MUST select the full suite and record why.
- **FR-014**: Results MUST reach Healer as `test_result` shapes via the CI adapter; log output MUST NOT
  cross (012 FR-022).

**Failures**

- **FR-015**: A bound test failing on the default branch or a declared environment, having passed on an
  earlier commit, MUST create an issue of kind `regression` with the test result, the last passing
  commit, the failing commit and the commit range as evidence.
- **FR-016**: Repeated failures of the same test MUST group by fingerprint (001); a fan-out above a
  declared bound in one run MUST group into one incident.
- **FR-017**: A failure on a pull request branch MUST NOT create an issue.
- **FR-018**: A `regression` issue MUST carry the bound expectation version as its candidate anchor;
  eligibility for a fix remains wholly 006, 007 and 008's to decide.
- **FR-019**: A flaky test MUST be quarantined per 008 FR-013; a quarantined test's failures MUST NOT
  create issues, and repeated quarantine of one test MUST route it to a human.

**Change of expectation**

- **FR-020**: A new adopted version of an expectation MUST mark its bound tests stale and produce a
  test pull request against the new version.
- **FR-021**: A change set editing a bound test's assertions while its expectation version is unchanged
  MUST be a masking candidate (008 FR-014) requiring human approval.
- **FR-022**: A retired expectation's bound tests MUST be removed by a pull request, and their failures
  MUST NOT create issues from the moment of retirement.

**Coverage**

- **FR-023**: Coverage MUST be computed per endpoint and page known to 004 as: no expectation · draft
  only · adopted without test · tested · tested and quarantined. A quarantined test MUST count as
  uncovered.
- **FR-024**: Coverage MUST be derived from bindings and the product graph at read time, not stored.

### Key Entities

- **RegressionTestBinding**: one test in the customer's repository bound to one expectation identifier
  and adopted version — test identifier, repository-relative path, rung, component, state (`active` ·
  `stale` · `quarantined` · `retired`), the pull request that introduced it. The only entity this
  feature adds to expected behaviour.
- **SuiteRun**: one execution reported by the customer's CI — trigger (`pull_request` · `schedule` ·
  `post_deploy`), commit, environment, selection reason, and references to its `test_result` evidence.

**Deliberately not persisted**: coverage (derived, FR-024); scenarios (they are `ExpectedBehavior`,
FR-001); test code (it lives in the customer's repository and never crosses).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of bound tests resolve to an expectation version with an active `AnchorGrant`; 0
  tests exist for unadopted drafts.
- **SC-002**: 100% of documented OpenAPI operations and response codes receive a draft, with 0 model
  calls for API drafting.
- **SC-003**: On the selection fixture set, 0 tests bound to a component in the impact closure are
  omitted from a pull request's selection.
- **SC-004**: A bound test failing on the default branch produces its `regression` issue within 5
  minutes of the result reaching Healer; 5 consecutive failures of one test produce exactly 1 issue.
- **SC-005**: 0 quarantined tests are counted as covered, and 0 of their failures create issues.
- **SC-006**: 0 test pull requests are opened for a test that failed against the default branch.
- **SC-007**: Median engineer review time per draft stays within the budget S0-5 establishes for
  expectation seeding; if S0-5 finds seeding unsurvivable, the draft cap is lowered, not the review.

## Assumptions

- User flows are features in 004's product graph (US6 there); this feature does not define a second
  notion of a flow. "Declared user flow" in C-28 means the same thing.
- The customer's CI can run the suite and report results through the CI adapter confirmed in S0-4.
  Where it cannot, the suite exists but only the pull-request and post-deploy paths the adapter
  supports are available, and the gap is shown in coverage.
- Healer's own repository can use the same mechanism, but its agent-authored changes follow 012 US10,
  where the red-first rule applies to new behaviour; a regression test for existing behaviour is
  required to pass on the base instead, which is why this feature's rule (FR-010) is the opposite one.
- Knowledge embeddings of customer documents are undecided (stage-0 S0-8); drafting does not depend on
  them, because it reads OpenAPI, routes and tests, not the vector index.
- Owners: expectations and adoption — 005; impact closure and product graph — 004; rungs and sandbox —
  007; masking and quarantine — 008; issues and fingerprints — 001; budgets and permission — 002.
  This feature owns bindings, selection, suite triggers and the failure-to-issue rule.
