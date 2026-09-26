# Feature Specification: Impact analysis, TDD fix, independent verification, pull request

**Feature Branch**: `008-change-and-verification`

**Created**: 2026-09-23

**Status**: Draft

**Input**: Know what a change touches before making it, write the regression test against an expectation that existed before the issue, fix until green, have a genuinely independent verifier that may reject the diagnosis and not only the patch, and open a pull request a human merges. Never merge.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Know what it touches before touching it (Priority: P1)

Before a file is opened for writing, Healer resolves what the change reaches: the symbols that
reference it, the API contract it implements, the database model behind it, the tests that cover it,
the events its component publishes, the feature flags guarding it. That graph — built by parsing,
not by asking a model — is what the change is scoped by. A one-line edit to an authorisation check
comes back classified higher than a thirty-file rename.

**Why this priority**: constitution V. Risk comes from what a change touches, and "the model thinks
this is a small change" is not an input the policy engine can check. The impact classification is a
structural fact (002 FR-003), so it has to be produced deterministically before anything that writes.

**Independent Test**: run impact analysis over a fixture set with known blast radii — an auth guard,
a shared utility, a migration, a large rename → classification and change graph match the expected
answer, and the auth guard outranks the rename.

**Acceptance Scenarios**:

1. **Given** a proposed change target, **When** impact analysis runs, **Then** the change graph is
   built first from deterministic sources — symbol references, type graph, call graph, API
   contracts, database models and migrations, test-to-code mapping, event producers and consumers,
   feature flags — and only then interpreted by a model.
2. **Given** a one-line change to an authorisation check and a thirty-file mechanical rename,
   **When** both are classified, **Then** the authorisation change carries the higher impact
   classification.
3. **Given** the model's interpretation contradicts the deterministic graph, **When** the
   classification is produced, **Then** the deterministic facts stand and the disagreement is
   recorded; a model may add context, never remove an edge.
4. **Given** impact analysis completes, **When** the result is persisted, **Then** it carries
   evidence references for each edge in the blast radius (001 FR-009).

---

### User Story 2 - The change is declared before it is made (Priority: P1)

The agent states, in advance: these primary files, these dependent files, these test files, for this
reason, at this impact classification, anchored on this expectation. Policy evaluates that
declaration. Anything the agent then writes outside it is refused.

**Why this priority**: a declared scope is what turns "an agent edited the repository" into a
reviewable proposal. It is also the payload policy needs (002 FR-001) and the summary an approver
reads (002 FR-015).

**Independent Test**: submit a `ChangePlan`, then attempt a write to an undeclared file → the write
is refused and the attempt is audited; extend the plan → policy re-evaluates before the write is
permitted.

**Acceptance Scenarios**:

1. **Given** a fix is about to begin, **When** the `ChangePlan` is submitted, **Then** it contains
   primary files, dependent files, test files, reason, impact classification and the expectation
   reference, and it is evaluated by the policy engine before any modification.
2. **Given** a declared `ChangePlan`, **When** the agent writes to a file not in it, **Then** the
   write is refused.
3. **Given** the fix genuinely requires a file outside the plan, **When** the plan is extended,
   **Then** the extended plan is re-evaluated by policy before work continues, and both versions are
   retained.
4. **Given** a change touching a database migration or an authorisation path, **When** policy
   evaluates the plan, **Then** the impact classification is available to it as a structural fact,
   never as a confidence value.

---

### User Story 3 - The regression test is anchored outside the chain (Priority: P1)

The test asserts `checkout-002`: *a duplicate checkout cannot create a duplicate order*. That
expectation was adopted by a human two months before the incident. The test is not written from the
diagnosis; it is written from the expectation, and it happens to fail on the broken code. When no
such expectation exists, the issue leaves the automated path and goes to a person.

**Why this priority**: this is the load-bearing requirement of the whole product. A regression test
derived from a diagnosis tests whatever the diagnosis assumed — a wrong diagnosis produces a wrong
test that fails on the old code and passes on the new one, and every gate reports PASS
(constitution II, `failure-modes.md` §1). A test that merely fails on the old code proves nothing.

**Independent Test**: attempt a fix for an issue with no adopted expectation → the automated path
refuses and hands off to a human; attempt one with an expectation adopted *after* the issue's
first-seen time → equally refused; attempt one with a pre-existing adopted expectation → permitted,
and the test carries the expectation identifier.

**Acceptance Scenarios**:

1. **Given** a regression test is written, **When** it is accepted, **Then** its assertion traces to
   an adopted `ExpectedBehavior` whose adoption timestamp precedes the issue's first-seen time, and
   the trace is recorded.
2. **Given** no adopted expectation covers the behaviour — the `NO_EXPECTATION` outcome of
   006 FR-011 — **When** a fix is requested, **Then** the issue is not eligible for the automated
   fix path and is handed to a human with the diagnosis and reproduction.
3. **Given** a machine-generated expectation is proposed to satisfy the anchor requirement, **When**
   it is evaluated, **Then** it is rejected; the system MUST NOT be able to author its own
   verification anchor (D-20, D-23).
4. **Given** the regression test is run against the pre-fix commit, **When** it does not fail, or
   fails with a signature other than the issue's, **Then** the loop stops — an unverified RED is not
   a RED.

---

### User Story 4 - Red, green, and nothing skipped (Priority: P1)

Reproduction fails. The regression test is added and verified RED for the right reason. The fix is
implemented. The test goes GREEN. The existing suite still passes. The end-to-end suite runs in the
customer's CI. Each state is persisted; none can be skipped, and a claim of GREEN without a
recorded RED does not exist.

**Why this priority**: the ordering is the proof. Out of order, "the tests pass" describes a test
written after the fix to match the fix.

**Independent Test**: drive the state machine and attempt to jump from fix to GREEN without a
recorded RED → refused; every transition is queryable afterwards with its execution identifier.

**Acceptance Scenarios**:

1. **Given** no reproduction with result `FAIL` exists (007 FR-001), **When** a fix is requested,
   **Then** it is refused.
2. **Given** the states reproduction → test-written → RED-verified → fix-implemented →
   GREEN-verified → suite-passed → e2e-delegated, **When** any transition is attempted out of
   order, **Then** it is refused, and the state machine is persisted and auditable.
3. **Given** a test in the existing suite passed before the change and fails after, **When**
   verification runs, **Then** it is a blocking failure regardless of the regression test's result.
4. **Given** end-to-end results are required and have not returned, **When** the fix is presented,
   **Then** it is not described as verified; it is described as awaiting CI (007 FR-022).

---

### User Story 5 - A verifier that can reject the diagnosis (Priority: P1)

The verifier is a different agent with different credentials, reading results and anchors rather
than the change agent's reasoning. It can return `APPROVE`, `REJECT_PATCH`, `REJECT_DIAGNOSIS` or
`INSUFFICIENT_EVIDENCE`. When it rejects the diagnosis, the issue goes back to 006 for its one
permitted re-diagnosis, not back to the change agent for another patch.

**Why this priority**: constitution II. A reviewer asked "does this fix the reported root cause?"
inherits the first model's premise, and two models are not two judges — shared training, shared
conditioning, shared blind spots (`failure-modes.md` §3). Being able to reject the premise is what
makes the reviewer something other than a second opinion on the wrong question.

**Independent Test**: feed the verifier a correct patch for a wrong diagnosis → it returns
`REJECT_DIAGNOSIS`; feed it a patch whose only evidence is the change agent's own output → it
returns `INSUFFICIENT_EVIDENCE`.

**Acceptance Scenarios**:

1. **Given** a completed fix, **When** verification runs, **Then** it is performed by an agent
   distinct from the change agent, with credentials that cannot write to the repository.
2. **Given** the patch is internally consistent but the diagnosis is wrong, **When** verification
   runs, **Then** `REJECT_DIAGNOSIS` is available and routes to 006 FR-024, not to another patch
   attempt.
3. **Given** a verdict, **When** it is recorded, **Then** it lists which verification anchors were
   available and which were used, ranked: production signal, human-written tests,
   expectation-anchored regression test, second model, self-review.
4. **Given** the only available anchor is the change agent's own output, **When** verification runs,
   **Then** the verdict MUST NOT be `APPROVE`.

---

### User Story 6 - Silencing the alarm is not a fix (Priority: P1)

The patch wraps the failing call in a try/catch and returns a default. The alert stops. The metric
recovers. Healer refuses it: the expectation says *an order is created exactly once*, not *no
exception is thrown*, and that assertion is not satisfied by suppressing the exception.

**Why this priority**: symptom masking is the default failure of this category and it is silent
(`failure-modes.md` §2). It satisfies "tests pass", it removes the evidence path, and the cause is
now harder to find than before Healer touched it.

**Independent Test**: run a fixture set of known masking patches — added catch, swallowed rejection,
retry loop, default fallback, widened type, weakened assertion — → each is rejected or escalated to
mandatory human approval, and none is auto-approved.

**Acceptance Scenarios**:

1. **Given** a change that adds exception suppression, a default fallback, a retry or a widened type
   at the failure site, **When** it is analysed, **Then** it is flagged as a masking candidate by
   deterministic diff inspection.
2. **Given** a masking candidate, **When** the anchored expectation's behavioural assertion is not
   independently satisfied, **Then** the change is rejected.
3. **Given** a masking candidate whose behavioural assertion *is* satisfied — the suppression is
   legitimately correct — **When** it proceeds, **Then** it requires human approval regardless of
   autonomy grant, and the flag appears in the pull request.
4. **Given** a change that weakens, deletes or skips an existing test, **When** it is analysed,
   **Then** it is treated as a masking candidate.

---

### User Story 7 - A pull request a human can actually review, and never a merge (Priority: P2)

The PR states the problem, the root cause with its evidence, the fix, the regression test and the
expectation it anchors on, the test results, the impact and risk assessment, the rollback plan and a
link to the issue. A human reads it and merges it, or does not. Healer has no merge button, in this
release, at all.

**Why this priority**: D-12 and the constitution's autonomy ceiling. The cost of a wrong fix is
bounded by review time only if review actually happens, which requires a PR worth reading. L3 waits
for a measured false-fix rate that does not yet exist.

**Independent Test**: generate PRs across the fixture set → every mandated section is present and
populated; attempt a merge through every available interface → no such capability exists.

**Acceptance Scenarios**:

1. **Given** an approved fix, **When** the pull request is created, **Then** it contains problem,
   root cause with evidence links, fix description, regression test with its expectation reference,
   test results, impact and risk assessment, rollback plan, issue link and audit reference.
2. **Given** PR creation is retried after a transient failure, **When** it runs again, **Then** the
   existing pull request is updated rather than a second one created.
3. **Given** any configuration, autonomy grant or agent request, **When** a merge is attempted,
   **Then** it is refused by a product-level limit (002 FR-008) and the change agent's credentials
   do not include merge permission.
4. **Given** an open Healer pull request already exists for the issue, **When** another fix attempt
   completes, **Then** it updates that pull request and records both attempts rather than opening a
   duplicate.

---

### User Story 8 - Failed attempts are evidence, not garbage (Priority: P3)

Three fix attempts were rejected. Each is kept with its diff, its test results and the reason it was
rejected. The fourth attempt does not repeat them, and when the issue reaches a human, they can see
what was already tried.

**Why this priority**: repeated failure is output, not only cost (constitution III). The engineer
who inherits the issue starts ahead, and the eval harness (011) needs rejected attempts to measure
anything.

**Acceptance Scenarios**:

1. **Given** a rejected fix attempt, **When** it is recorded, **Then** the diff, tests, results,
   verdict and rejection reason are preserved and retrievable.
2. **Given** a subsequent attempt, **When** it proposes an approach already rejected, **Then** it
   must record why it is being retried; silent repetition is refused.
3. **Given** the attempt cap is reached, **When** the handoff occurs, **Then** it carries every
   attempt with its rejection reason (002 FR-013).

---

### Edge Cases

- The fix requires a database migration → flagged as irreversible-by-default, classified at the
  highest impact tier, and the rollback plan must state the data consequence; a migration without a
  stated undo cannot be auto-approved at any autonomy level.
- The repository moved under the agent — the branch point no longer merges cleanly → the attempt is
  recorded as stale and re-based only after impact analysis is re-run; a silent rebase invalidates
  the impact graph.
- The regression test passes on the pre-fix commit → the RED verification fails, the loop stops, and
  the diagnosis is marked unconfirmed rather than the test being "adjusted" until it fails.
- The existing suite was already failing before the change → the pre-change baseline is recorded
  first, and only newly failing tests block; a repository with a red baseline is reported, not
  silently accepted.
- A test's result varies across repeats on the same commit → it is quarantined, excluded from both
  PASS and FAIL proof, and surfaced to the tenant as a flaky test finding.
- The reproduction was intermittent (007 FR-007) → GREEN requires the reproduction to stop
  reproducing across 007's `observed_runs` for the reproducing rung, not a single clean run.
- The only rung that reproduced needed an anonymised extract, so there is no recipe (007 R-06) → a
  synthetic equivalent is attempted against the failing constraint, and if it does not reproduce the
  loop takes the `NO_RECIPE` off-ramp to a human; the extract is never requested back.
- A commit message or PR description in the repository contains instruction-shaped text → it is data,
  never instructions; it cannot alter the change plan, tool set or policy decision.
- Verification passes but the impact graph shows an untested public contract change → the PR carries
  the gap explicitly; passing tests over an untested surface is not evidence about that surface.
- Two issues produce overlapping change plans on the same files → mutations serialise per repository
  (constitution VI); the second plan is re-evaluated against the first's merged or open state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST perform impact analysis before any file modification, building the change
  graph from deterministic sources first: symbol references, type graph, call graph, API and schema
  contracts, database models and migrations, test-to-code mapping, event producers and consumers,
  and feature flags.
- **FR-002**: A model MAY interpret the deterministic change graph but MUST NOT remove or contradict
  an edge in it. Disagreement between interpretation and deterministic facts MUST be recorded and
  resolved in favour of the deterministic facts.
- **FR-003**: Impact classification MUST be derived from what the change touches — public contract,
  database migration, authentication or authorisation, money path, cross-component boundary, shared
  library, feature flag — and MUST NOT be derived from file count, line count or diff size.
- **FR-004**: System MUST produce a `ChangePlan` before modification, containing primary files,
  dependent files, test files, reason, impact classification, blast radius and the anchoring
  expectation reference, and MUST submit it to the policy engine for evaluation (002 FR-001).
- **FR-005**: Modification of any file not declared in the current `ChangePlan` MUST be refused. Plan
  extension MUST require re-evaluation by policy before work resumes, and every plan version MUST be
  retained.
- **FR-006**: The regression test's assertion MUST trace to an adopted `ExpectedBehavior` whose
  adoption timestamp precedes the issue's first-seen time. The system MUST verify this and record
  the trace.
- **FR-007**: When no such expectation exists — including the `NO_EXPECTATION` outcome of
  006 FR-011 — the issue MUST NOT be eligible for the automated fix path and MUST be handed to a
  human with the diagnosis and reproduction evidence.
- **FR-008**: The system MUST NOT create, adopt or amend an `ExpectedBehavior` in order to satisfy
  FR-006. Machine-generated knowledge MUST NOT become a verification anchor (D-20, D-23).
- **FR-009**: System MUST enforce the fix loop as a persisted state machine in the order:
  reproduction `FAIL` (007 FR-001) → regression test written → RED verified → fix implemented →
  GREEN verified → existing suite passed → end-to-end delegated. Out-of-order transitions MUST be
  refused. The loop's **entry guard MUST itself read both** `diagnosis.fix_eligibility` (006 FR-002)
  **and** `reproduction.change_eligibility` (007 FR-001) and MUST refuse unless both are true. It MUST
  NOT take either fact from an event payload: `DiagnosisCompleted` and `ReproductionCompleted` are
  triggers, never the authority (C-08).
- **FR-010**: RED verification MUST require that the regression test fails on the pre-fix commit
  *with a failure signature matching the issue*. A test that fails for another reason, or does not
  fail, MUST stop the loop.
- **FR-011**: GREEN verification MUST require the regression test to pass on the fixed commit and
  the reproduction to stop reproducing. Where the reproduction was intermittent (007 FR-007), GREEN
  MUST require **007's `observed_runs` for the reproducing rung** — the repeat count that produced the
  recorded rate (007 R-18) — to be clean. This is not this feature's own flakiness `repeat_count`,
  which governs quarantine (FR-013); naming both "the full repeat count" is what made them
  indistinguishable.
- **FR-011a**: Where the only reproducing rung required an anonymised extract, no recipe exists
  (007 FR-024, 007 R-06, C-04). The system MUST attempt a **synthetic equivalent** built to the
  failing constraint, and where that does not reproduce MUST take the `NO_RECIPE` off-ramp to a human
  carrying the reproduction record and the constraint it could not satisfy. It MUST NOT request,
  regenerate or persist the extract, and MUST NOT proceed on an unreproduced fixture (C-23).
- **FR-012**: Any test that passed on the pre-change baseline and fails after the change MUST be a
  blocking failure. The pre-change baseline MUST be recorded before the change, and an
  already-failing baseline MUST be reported rather than silently accepted.
- **FR-013**: A test whose result varies across repeats on the same commit MUST be quarantined. A
  quarantined test MUST NOT count as proof of `PASS` or of `FAIL`, and its quarantine MUST be
  surfaced to the tenant.
- **FR-014**: System MUST detect masking candidates by deterministic diff inspection — added
  exception suppression, swallowed rejections, added retry or default fallback at the failure site,
  widened or loosened types, and weakened, skipped or deleted tests.
- **FR-014a**: A `ChangePlan` path or patch hunk path that resolves to an **expectation-defining
  document** (005's repository markdown sources) MUST be a **hard refusal** in the masking-class
  checks — not a candidate weighed against the anchor, and not reachable through human approval on
  this request. A fix that edits an expectation carries its own anchor past a reviewer who believes
  they are approving a bug fix. An expectation change is a separate merge request, adopted by a human
  in 005 (FR-008, D-20, D-23).
- **FR-015**: A masking candidate MUST be rejected unless the anchored expectation's behavioural
  assertion is independently satisfied. Where it is satisfied, the change MUST still require human
  approval regardless of autonomy grant, and the flag MUST appear in the pull request.
- **FR-016**: Verification MUST be performed by an agent distinct from the change agent, with
  credentials that cannot write to the repository, reading execution results and anchors rather than
  the change agent's reasoning.
- **FR-016a**: The change agent, the masking inspection of FR-014 and the verifier of FR-016 MUST
  execute in the execution plane, against the tenant's provider (ADR 0010, C-33). The control plane
  MUST receive only `change_plan_proposal`, `masking_candidate`, `verification_verdict`,
  `test_result`, `pull_request_ref` and `agent_run_report`; patch content MUST NOT cross. The verifier
  MUST run under a directive and credentials separate from the change agent's.
- **FR-017**: The verifier's verdict vocabulary MUST be `APPROVE`, `REJECT_PATCH`,
  `REJECT_DIAGNOSIS` and `INSUFFICIENT_EVIDENCE`. `REJECT_DIAGNOSIS` MUST route to re-diagnosis
  (006 FR-024), not to another patch attempt.
- **FR-018**: Every verdict MUST record the verification anchors available and used, ranked by
  independence: production signal, human-written tests, expectation-anchored regression test, second
  model, self-review. `APPROVE` MUST NOT be returned when the only anchor is an artifact produced
  earlier in the same chain.
- **FR-019**: Model-reported confidence MUST NOT be an input to any gate, verdict predicate or
  policy decision in this feature (constitution IV, 002 FR-003). It MAY be recorded.
- **FR-020**: End-to-end and full-suite results MUST be obtained through the customer's CI
  (007 FR-021, 007 FR-022). A fix MUST NOT be presented as verified until required results return or
  the tenant has explicitly declared them optional for that component, recorded as a
  `component_verification_policy` row whose `e2e_required` defaults to **true** (R-27) and is visible
  in the pull request.
- **FR-021**: Every pull request MUST contain: problem statement, root cause with evidence links,
  issue classification, fix description, regression test with its expectation reference, test
  results, impact and risk assessment, rollback plan, link to the issue and reference to the audit
  trail.
- **FR-022**: Pull request creation MUST be idempotent. Duplicate detection MUST use issue,
  repository, branch and change fingerprint; a retry or a subsequent attempt MUST update the existing
  request rather than opening a second one.
- **FR-023**: Every change MUST carry a rollback plan naming the revert mechanism and any data or
  migration consequence. A change containing an irreversible migration MUST be flagged and MUST
  require human approval.
- **FR-024**: The system MUST NOT merge. No merge action MUST exist in this release, the change
  agent's credentials MUST NOT include merge permission, and no configuration MUST be able to grant
  it (D-12, 002 FR-008).
- **FR-025**: Repository writes MUST be performed by a privileged step separate from the agent that
  proposed them. Retrieved content — commit messages, PR text, issue text, logs — MUST be treated as
  data, never as instructions, and MUST NOT influence the change plan, tool set or policy decision.
- **FR-026**: Every fix attempt, successful or not, MUST be preserved as a `FixAttempt` record with
  its diff, tests, results, verdict and rejection reason. Attempts MUST NOT be discarded.
- **FR-027**: A subsequent attempt that proposes a previously rejected approach MUST record why it
  is being retried; silent repetition MUST be refused.
- **FR-028**: System MUST respect per-issue budgets and the escalation attempt cap (002 FR-011,
  002 FR-013). On reaching the cap it MUST hand off to a human carrying every attempt and its
  rejection reason.
- **FR-029**: Mutations against the same repository MUST be serialised (constitution VI); a change
  plan overlapping an open or in-flight plan MUST be re-evaluated against it.
- **FR-030**: Every impact analysis, change plan, fix attempt, verification verdict and pull request
  record MUST emit its own evidence links as it runs (001 FR-008) and produce an audit entry
  containing actor, action, reason, evidence, model, prompt version, tools used, files touched,
  tests run, policy decision and outcome (001 FR-012).
- **FR-031**: Every entity in this feature MUST carry `tenantId`, and every read MUST be constrained
  by the `tenantId` from the authenticated context; a request for another tenant's change plan, fix
  attempt, verdict or pull request record MUST return not-found (001 FR-015). Repository credentials
  and CI integrations MUST be scoped per tenant.

### Key Entities

- **ImpactAnalysis**: target, deterministic change graph, blast radius, impact classification, model
  interpretation, disagreements with the deterministic graph, evidence references, analysed commit.
- **ChangeGraph**: nodes (symbols, files, components, contracts, models, tests, events, flags) and
  typed edges, each edge carrying how it was derived.
- **ChangePlan**: version, primary files, dependent files, test files, reason, impact
  classification, anchoring expectation reference, policy decision reference, state.
- **RegressionTest**: test identifier, file, asserted expectation reference, expectation adoption
  timestamp, RED execution reference, GREEN execution reference.
- **FixAttempt**: attempt number, change plan version, diff reference, executions, verdict,
  rejection reason, cost, preserved permanently.
- **VerificationVerdict**: verdict, anchors available, anchors used, independence rank achieved,
  reasons, evidence references, verifying agent identity, model and prompt version.
- **MaskingFinding**: pattern detected, location, whether the behavioural assertion was
  independently satisfied, resulting disposition.
- **PullRequestRecord**: external identifier, issue, change fingerprint, contents checklist state,
  creation idempotency key, update history.
- **RollbackPlan**: revert mechanism, data or migration consequence, reversibility classification.
- **ComponentVerificationPolicy**: component, whether end-to-end results are required (default true),
  who declared it and when. Read by the `VERIFIED` guard (FR-020, R-27).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 merges are performed by the system, verified by the absence of a merge capability
  and by reconciling repository merge events against Healer actors.
- **SC-002**: 100% of accepted regression tests resolve to an `ExpectedBehavior` adopted before the
  issue's first-seen time, verified by a continuous invariant check.
- **SC-003**: 0 fixes reach `APPROVE` where the only verification anchor is an artifact produced
  earlier in the same chain.
- **SC-004**: 0 `PASS` verdicts depend on a quarantined or flaky test.
- **SC-005**: 0 file modifications occur outside a policy-evaluated `ChangePlan`.
- **SC-006**: 100% of pull requests contain every mandated section, verified by an automated
  completeness check that blocks creation otherwise.
- **SC-007**: 0 duplicate pull requests are created under an induced retry and concurrency test.
- **SC-008**: On the impact fixture set, a single-line authorisation change is classified above a
  thirty-file mechanical rename in 100% of cases, and impact classification is independent of diff
  size.
- **SC-009**: On the symptom-masking fixture set, 0 masking patches are approved without human
  review. The share correctly rejected outright is measured against a threshold derived from the
  stage-0 benchmark ([stage-0.md](../../docs/stage-0.md) S0-3), not chosen in advance; until that
  threshold exists the absolute requirement — 0 approved without review — is the whole criterion.
- **SC-010**: 0 GREEN verifications are recorded without a preceding signature-matched RED for the
  same regression test.
- **SC-011**: False-fix rate is measured on the golden dataset (011) and reported per release. Until
  the stage-0 threshold exists, the measurement is published and L2 remains the ceiling.
- **SC-012**: 100% of rejected fix attempts remain retrievable with their diff, results and
  rejection reason.
- **SC-013**: 0 cross-tenant reads of change plans, fix attempts, verdicts or pull request records
  succeed in the isolation test matrix.

## Assumptions

- This specification owns impact analysis, the TDD fix loop, independent verification and pull
  request creation only. It does not own policy decisions (002), reproduction and sandbox execution
  (007), diagnosis (006), expectation authoring and adoption (005), the architecture graph (004), or
  deployment and merge — which are out of v1 scope entirely.
- Code intelligence for the deterministic change graph comes from the v1 adapter set for a single
  stack (constitution VII); an unsupported language degrades the graph to what is derivable and the
  gap is stated on the change plan rather than filled by a model.
- The VCS adapter for v1 is the design partner's; pull request semantics are expressed against the
  generic record and adapted, so the no-merge guarantee is enforced by credential scope as well as
  by the absence of the action.
- Flakiness detection uses repeated execution on the same commit rather than historical result data,
  because a new tenant has no history at onboarding; the repeat count is configuration tuned in
  stage 0.
- Masking detection is deterministic pattern inspection plus an expectation check, deliberately
  biased toward false positives. A false positive costs a human review; a false negative ships a
  patch that hides the incident.
- The verifier is a second model in v1, which the constitution ranks as weak independence. It is
  acceptable only because the expectation-anchored regression test and raw evidence rank above it
  and are required; the verifier is the last line, never the primary one.
- Budget values, attempt caps, false-fix threshold and the masking rejection threshold are
  configuration derived from the stage-0 benchmark, not chosen in advance.
