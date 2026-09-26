# Feature Specification: Reversible production actions

**Feature Branch**: `010-safe-remediation`

**Created**: 2026-09-23

**Status**: Draft

**Input**: A closed catalogue of reversible production actions — rollback, restart, feature-flag disable, scale, queue drain, job retry — each declaring a precondition, an action, a verification and an undo, executed in the customer's execution plane under policy, verified within a window, and automatically undone when the expected improvement does not appear.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Rollback, verified, or undone (Priority: P1)

Error rate on checkout jumps four minutes after a deploy. Healer correlates the deploy, proposes a
rollback of that deployment, policy permits it for this component in this environment, and the
runner executes it. Eight minutes later the error rate is back at baseline and the action is marked
verified. Had it not returned to baseline, the rollback would have been rolled forward again
automatically and the issue reopened for a human.

**Why this priority**: this is where v1's MTTR improvement actually comes from. Rollback alone
likely beats code-fixing on MTTR, it is the first thing an on-call engineer does anyway, and unlike
a patch it is reversible by construction, verifiable in minutes against production signal, and
bounded in blast radius when wrong.

**Independent Test**: replay a deploy-correlated regression in a staging environment → rollback is
proposed, executed, verified against a metric that existed before the incident, and a forced
non-improvement triggers the undo and reopens the issue.

**Acceptance Scenarios**:

1. **Given** an action is proposed, **When** it is executed, **Then** a policy decision preceded it
   (002 FR-001) and the decision is recorded with its rule version (002 FR-017).
2. **Given** an executed action, **When** its verification window elapses without the expected
   improvement, **Then** the undo runs automatically and the issue is reopened (002 FR-010).
3. **Given** a verification window, **When** the expected improvement is observed, **Then** the
   observation is an evidence record emitted by the verification step (001 FR-008) referencing a
   production signal, not the action's own report of success.
4. **Given** the action executed and verification is pending, **When** the system waits, **Then** it
   waits as a persisted state plus an inbound callback, never inside a job.

---

### User Story 2 - Four declarations or it is not in the catalogue (Priority: P1)

Every action in the catalogue declares what must be true before it runs, what it does, how its
effect is checked, and how it is undone. An action whose undo cannot be demonstrated is not
reversible; it is simply an action nobody has tested the consequences of, and it does not ship.

**Why this priority**: 002 FR-009 makes reversibility a structural claim. This feature is where that
claim is either substantiated per action or the whole "reversible actions are governed separately"
argument is decoration.

**Independent Test**: an automated catalogue check fails the build if any action lacks a
precondition, a verification, an undo, or a passing undo test.

**Acceptance Scenarios**:

1. **Given** an action definition missing any of precondition, action, verification or undo,
   **When** the catalogue loads, **Then** the action is rejected and cannot be proposed.
2. **Given** an action classified as reversible, **When** its classification is checked, **Then**
   it has an undo that has been executed successfully in a test within the current release
   (002 FR-009).
3. **Given** a precondition that does not hold at execution time, **When** execution is attempted,
   **Then** the action is refused and the failed precondition is recorded — preconditions are
   re-checked at execution, not only at proposal.
4. **Given** an action whose verification cannot be anchored on a signal that existed before the
   issue, **When** it is defined, **Then** it is rejected — an action verified by its own output is
   not verified.

---

### User Story 3 - Dry-run before anything moves (Priority: P1)

An engineer, or the simulator, asks what a proposed remediation would do. The answer names the
target, the exact operation, the current state it would change, the blast radius, the policy
decision, the verification that would be applied and the undo that would be available — without
touching anything.

**Why this priority**: it is how a customer grants autonomy for the first time, and it is what 011
replays historically. An action class nobody can inspect before enabling is an action class nobody
enables.

**Independent Test**: run every catalogue action in dry-run against a live environment → no state
changes occur, verified by the environment's own audit log, and every dry-run returns a complete
plan.

**Acceptance Scenarios**:

1. **Given** any catalogue action, **When** it is invoked in dry-run mode, **Then** it returns the
   resolved target, the operation, the observed current state, the blast radius, the verification
   plan and the undo plan, and mutates nothing.
2. **Given** a dry-run, **When** policy is consulted, **Then** it uses dry-run evaluation
   (002 FR-019) and returns the decision and the rules that produced it.
3. **Given** a dry-run whose precondition does not hold, **When** it returns, **Then** it reports the
   failing precondition rather than a plan.

---

### User Story 4 - The control plane decides, the customer's plane acts (Priority: P1)

The decision to roll back is made in Healer. The rollback itself is performed by the runner inside
the customer's infrastructure, using the customer's own credentials, through a declared,
schema-validated action — not a shell command, not a generated script.

**Why this priority**: D-02 and the security model. A product that executes arbitrary commands in a
customer's production plane fails procurement, and correctly so.

**Independent Test**: inspect the runner's action surface → every action is a named schema with
validated parameters; no generic command execution endpoint exists.

**Acceptance Scenarios**:

1. **Given** an approved action, **When** it executes, **Then** it executes in the customer's
   execution plane through a declared, schema-validated action definition.
2. **Given** any agent, **When** it attempts to reach the execution plane, **Then** it can invoke
   only catalogue actions its capability-scoped credential permits, and never raw shell.
3. **Given** any invocation, **When** it completes or fails, **Then** an audit record exists with
   actor, action, target, parameters, policy decision, outcome and evidence references
   (001 FR-012).
4. **Given** the invocation result, **When** it crosses the plane boundary, **Then** it carries
   structured evidence — state before, state after, metric deltas, operation identifiers — and never
   raw log bodies.

---

### User Story 5 - Autonomous only where autonomy was granted (Priority: P1)

Autonomous rollback is enabled for one service in production. Restart is enabled in staging only.
Everything else requires approval. A proposal for a component with no grant is refused with the
missing grant named.

**Why this priority**: D-14 makes reversible remediation the only autonomous production action in
year one, which makes the granularity of the grant the entire safety boundary.

**Acceptance Scenarios**:

1. **Given** autonomy granted per component, environment and action (002 FR-007), **When** the same
   action is proposed elsewhere, **Then** it is refused naming the missing grant.
2. **Given** no matching rule, **When** policy evaluates, **Then** the result is `DENY`
   (002 FR-005) — absence of a rule never permits a production action.
3. **Given** a grant is revoked mid-workflow, **When** the guarded step is reached, **Then** it
   stops and requires approval (002 FR-007).
4. **Given** `REQUIRE_APPROVAL`, **When** the request is displayed, **Then** it shows the action,
   the reason, the evidence, the blast radius and the undo plan (002 FR-015).

---

### User Story 6 - A remediation that keeps being needed is a signal (Priority: P1)

A worker is restarted. The issue recurs in twenty minutes. It is restarted again. On the third
occurrence the system stops restarting and escalates, carrying the pattern: three remediations, same
target, same signature, six hours. The remediation was treating a symptom and the recurrence is the
diagnosis.

**Why this priority**: this is the difference between a remediation system and an automated
symptom-masking machine. A loop that quietly keeps a broken system alive is worse than an outage,
because nobody is paged and the cause compounds.

**Independent Test**: induce a recurring failure with a remediation that temporarily relieves it →
the attempt cap is reached, further attempts are refused, and the escalation names the repetition.

**Acceptance Scenarios**:

1. **Given** repeated remediation within one `(tenant, target, fingerprint)` group — whether or not
   each recurrence created a new issue — **When** the governing attempt cap is reached, **Then**
   further attempts are refused and a human is escalated to (002 FR-013, R-08).
2. **Given** a target under cooldown, **When** an action against it is proposed, **Then** it is
   refused until the cooldown elapses (002 FR-014).
3. **Given** an escalation caused by repetition, **When** it is delivered, **Then** it carries the
   remediation history, the recurrence interval and the evidence from each attempt.
4. **Given** an issue classified as a code problem, **When** a remediation is proposed as its
   resolution, **Then** the remediation is recorded as mitigation, and the issue is not closed by
   it.

---

### User Story 7 - When the undo fails (Priority: P2)

A rollback is executed. Verification fails. The undo is attempted and it also fails. The system
stops. Both failures are recorded, the issue escalates immediately, and no further automated action
is taken against that target until a human intervenes.

**Why this priority**: the undo failing is the scenario that turns a safe action class into an
unsafe one. The only correct behaviour is to stop, and it has to be specified rather than assumed.

**Acceptance Scenarios**:

1. **Given** an undo that fails, **When** the failure is detected, **Then** both the original
   verification failure and the undo failure are recorded as evidence, the issue escalates
   immediately, and no further automated attempts occur.
2. **Given** a target in that state, **When** any further automated action is proposed against it,
   **Then** it is refused until a human clears the state.
3. **Given** the escalation, **When** it is delivered, **Then** it names the state the target was
   left in, as observed, not as intended.

---

### User Story 8 - Blast radius is declared and bounded (Priority: P2)

Scaling a service is bounded by a maximum replica delta. Draining a queue is bounded by message
count and by which queues are eligible. Disabling a feature flag is bounded to flags marked
remediable. A proposal exceeding a bound is refused, not truncated.

**Acceptance Scenarios**:

1. **Given** an action with a declared blast-radius limit, **When** a proposal exceeds it, **Then**
   the proposal is refused with the limit named.
2. **Given** a target not marked eligible for an action, **When** the action is proposed, **Then**
   it is refused — eligibility is opt-in per target.
3. **Given** concurrent proposals against the same target, **When** the second is evaluated,
   **Then** it is serialised behind the first; mutations against one target never run in parallel.

---

### Edge Cases

- A queue drain is proposed but the messages are still needed → drain is defined as move-to-holding
  with a restore undo, never delete; an action whose undo is "the data is gone" is not in the
  catalogue.
- Rollback target is the currently deployed version (nothing to roll back to) → precondition fails
  at execution time and the action is refused.
- The previous deployment is itself known-bad → rollback is refused with the known-bad version named.
- Rollback would revert a database migration → refused; migration-bearing deployments are outside the
  reversible class and require approval with an explicit human plan.
- The expected improvement metric is unavailable during the verification window → the window ends in
  `INCONCLUSIVE`, which triggers the undo and escalates, because an unverifiable action is treated
  as an unsuccessful one.
- Another actor — a human, a deployment pipeline — changes the target during the verification window
  → the change is detected, the verification is invalidated and the outcome is escalated rather than
  attributed to the remediation.
- The runner loses connectivity after dispatching an action → the action is idempotent by invocation
  identifier; on reconnection its state is reconciled from the target, never assumed.
- An action succeeds but its result event is delivered twice → the duplicate does not double-apply.
- Restarting the last healthy replica of a component → precondition includes a minimum healthy
  replica count, and the action is refused when it would breach it.
- Feature-flag disable affects a flag used as a kill switch by another system → flags are eligible
  only when explicitly marked remediable by the tenant.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST maintain a closed, versioned catalogue of remediation actions. The v1
  catalogue is: rollback deployment, restart worker or pod, disable feature flag, scale service,
  drain queue, retry stuck job. An action not in the catalogue MUST NOT be executable.
- **FR-002**: Every catalogue action MUST declare a precondition, the action itself, a verification
  and an undo (002 FR-009). An action missing any of the four MUST be rejected at catalogue load.
- **FR-003**: An action MUST NOT be classified as reversible unless its undo has been executed
  successfully in an automated test within the current release. The attestation that test writes MUST
  be the **only** source of 002's `hasTestedUndo` fact, published on `RemediationCataloguePublished`;
  under C-18 `ACTION_CEILING` is `f(actionClass, hasTestedUndo)`, so an unattested undo leaves
  `reversible_remediation` with no autonomy level rather than with a permission it cannot justify.
- **FR-004**: Preconditions MUST be re-evaluated immediately before execution, not only at proposal
  time, and a failed precondition MUST refuse the action and record which precondition failed.
- **FR-005**: Verification MUST anchor on a production signal or another artifact that existed
  before the issue, and MUST NOT anchor on any artifact produced by the remediation chain itself.
- **FR-006**: Every executed action MUST have a declared verification window. Failure to observe the
  expected improvement within it, or inability to observe the signal at all, MUST trigger the undo
  automatically and reopen the issue (002 FR-010).
- **FR-007**: System MUST provide a dry-run mode for every catalogue action, returning the resolved
  target, operation, observed current state, blast radius, verification plan, undo plan and the
  policy decision from dry-run evaluation (002 FR-019), with no state mutation.
- **FR-008**: Every action MUST be evaluated by the policy engine before execution, with no bypass
  path (002 FR-001), and MUST execute only where autonomy is granted for that tenant, component,
  environment, issue type and action (002 FR-007).
- **FR-009**: Actions MUST execute in the customer's execution plane (D-02) through declared,
  schema-validated action definitions invoked by the runner. No path granting an agent raw shell or
  arbitrary command execution MUST exist. Dispatch MUST take a `RemediationDispatchCapability` as an
  argument and MUST NOT be able to resolve one from a dependency-injection container, a module import,
  ambient configuration or a global ([ADR 0008](../../docs/adr/0008-capability-passing.md)), so a run
  constructed without it — every simulation run — cannot reach dispatch at all.
- **FR-010**: Every invocation MUST be idempotent per invocation identifier; a retried or duplicated
  dispatch MUST NOT apply the action twice.
- **FR-011**: Waiting for an action result or a verification window MUST be a persisted state plus an
  inbound callback. No job may block on a remediation outcome.
- **FR-012**: Mutations against a single target MUST be serialised; two remediation actions MUST NOT
  execute concurrently against the same target.
- **FR-013**: Rate limits, cooldowns and attempt caps are **owned and evaluated by 002** (002 FR-013,
  002 FR-014), scoped by the `targetRef` and `fingerprint` this feature supplies on `DecisionInput`.
  This feature MUST supply both scoping fields, MUST refuse the action when the resulting decision
  denies it, and MUST record the refusal under the projected reason code — `RATE_LIMITED`, `COOLDOWN`
  or `ATTEMPT_CAP` — so the tenant learns why nothing happened. It MUST NOT store or evaluate those
  limits a second time (C-11).
- **FR-014**: Every action MUST declare a blast-radius limit — replica delta, message count,
  affected targets, flag scope — and a proposal exceeding it MUST be refused, never truncated to fit.
- **FR-015**: Targets MUST be opt-in per action type, and eligibility MUST be the **conjunction** of
  two facts: a stored opt-in row for `(target, action)` **and** the presence of every per-target
  declaration that action requires — `min_healthy_replicas`, `min_replicas`/`max_replicas`,
  `remediable_flag_keys`, `holding_destination`, `idempotency_declared` (R-17). An action MUST NOT
  apply to a target missing either half: an opt-in without the declaration is agreement to an action
  whose bound is unknown, and a declaration without the opt-in is a bound nobody agreed to apply. A
  null declaration MUST be read as undeclared, never as zero or false.
- **FR-016**: Repeated remediation within one `(tenant, target, fingerprint)` group MUST escalate on
  reaching the attempt cap (002 FR-013), and the escalation MUST carry the remediation history,
  recurrence intervals and per-attempt evidence. The group is the counting key precisely because a
  recurrence outside the reopen window creates a **new** issue (001 FR-005, R-08), so "the same issue"
  is the wording that makes the cap blind in the restart loop it was written for. Where one group
  contains attempts under several action keys, the governing cap MUST be the **minimum** over the
  `attempt_cap` values of the action keys present — the most cautious bound in the group, since a
  target being hit by three different remediations is a stronger recurrence signal than one being hit
  by the same one three times.
- **FR-017**: A remediation MUST be recorded as mitigation, never as resolution of a code problem,
  and MUST NOT close an issue classified as a code problem.
- **FR-018**: A remediation MUST NOT be proposed as a substitute for diagnosis; an action MUST
  reference the diagnosis or correlation evidence that justifies it (001 FR-009).
- **FR-019**: Failure of an undo MUST record both the verification failure and the undo failure as
  evidence, escalate immediately, and block all further automated actions against that target until
  a human clears the block. No further automated attempt MUST occur.
- **FR-020**: Detection of an external change to the target during a verification window MUST
  invalidate the verification and escalate, rather than attributing the observed outcome to the
  remediation.
- **FR-021**: An action whose undo would not restore the prior state — irreversible deletion, data
  loss — MUST NOT be admitted to the catalogue. Queue drain MUST be defined as move-to-holding with a
  restore undo.
- **FR-022**: Rollback MUST be refused when the target deployment carries an irreversible schema
  migration, when the previous version is marked known-bad, or when there is no prior version.
- **FR-022a**: Rollback's undo MUST be the separate, undo-only action key
  `deployment.restore_dispatch_version`, whose single parameter MUST equal the attempt's
  `revision_ref_at_dispatch` and therefore names exactly one deployment (C-15). It MUST NOT be
  proposable, MUST NOT accept an eligibility entry, and MUST NOT be expressible with any other
  revision — `deployment.rollback`'s own schema can only name a deployment *preceding* the current
  one (R-04), while undoing a rollback names the one that *succeeded* it, so reusing that key would
  either fail its own precondition or make a forward deploy expressible.
- **FR-023**: Every remediation attempt, outcome, verification result and undo MUST be written to the
  audit trail with actor, action, target, parameters, policy decision, evidence references and
  outcome (001 FR-012, 002 FR-017).
- **FR-024**: Every remediation record, action definition binding, target eligibility entry and
  cooldown state MUST carry `tenantId`, and every read and every execution MUST be constrained by the
  `tenantId` from the authenticated context (001 FR-015). A remediation MUST NOT be able to target a
  resource belonging to another tenant, enforced at the query and dispatch layer rather than by
  post-filtering.
- **FR-025**: Results crossing the plane boundary MUST be structured evidence — state before, state
  after, metric deltas, operation identifiers — and MUST NOT include raw log bodies.

### Key Entities

- **RemediationAction**: a catalogue entry. Action type, parameter schema, precondition, verification
  definition, undo definition (an action key, not always this action's own — FR-022a), blast-radius
  limit, verification window, required autonomy level, catalogue version, undo attestation. Rate
  limits, cooldowns and attempt caps are **not** attributes of a catalogue entry: they are 002's
  (FR-013, C-11).
- **RemediationTarget**: the resource an action applies to — deployment, workload, flag, queue, job —
  with tenant, component, environment, per-action eligibility and the per-action declarations
  eligibility is conjoined with (FR-015).
- **RemediationAttempt**: proposal, policy decision, dry-run result, invocation identifier, execution
  result, verification outcome, undo outcome, evidence references, actor.
- **VerificationWindow**: the signal observed, its pre-incident baseline, the expected improvement,
  the window duration and the observed outcome (`improved` | `not_improved` | `inconclusive`).
- **UndoRecord**: what was restored, the observed state before and after, and the result.
- **TargetBlock**: a target placed out of automated reach after an undo failure, with the reason and
  the human who may clear it.
- **RemediationHistory**: attempts against an issue or target over time — the input to the recurrence
  escalation and a signal in its own right.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of catalogue actions have a precondition, verification and undo, with a passing
  undo test in the current release, verified by a check that fails the build otherwise.
- **SC-002**: 0 remediation actions execute without a recorded policy decision.
- **SC-003**: 100% of actions whose verification window closes without the expected improvement are
  followed by an executed undo and a reopened issue.
- **SC-004**: 0 actions execute outside a granted autonomy scope in the grant matrix test.
- **SC-005**: 0 state mutations occur during dry-run execution of every catalogue action, verified
  against the target environment's own audit log.
- **SC-006**: 0 execution paths exist that reach the execution plane without a schema-validated
  action definition, verified by an automated surface audit.
- **SC-007**: Duplicate dispatch of an action produces exactly one applied effect in 100% of
  idempotency tests.
- **SC-008**: 0 automated attempts occur against a target after an undo failure.
- **SC-009**: 0 cross-tenant targets are reachable in the isolation matrix covering every action type.
- **SC-010**: Measured on **live tenant data at L2 or above**, the median
  `time_to_verified_remediation` for deploy-correlated regressions is **at most half** the median time
  from issue creation to a merged code fix for deploy-correlated regressions on the same tenant — that
  is the margin "materially shorter" means. The measure carries an availability tri-state of the same
  shape as 011's `revert_rate_30d` — `available` · `insufficient_observation` · `not_applicable` — and
  is reported as `insufficient_observation` with its reason until a tenant has produced both
  populations. It is **not** a benchmark metric: a simulation dispatches no remediation and merges
  nothing, so the comparison is unmeasurable in a replay and the benchmark is the wrong denominator
  for it.
- **SC-011**: 100% of `(tenant, target, fingerprint)` groups that reach the governing `attempt_cap`
  within the recurrence window appear as escalations rather than continued remediation. The group, not
  the issue, is the subject: in the restart-loop case each recurrence outside the reopen window is a
  **new** issue (001 FR-005, R-08), so a criterion counted per issue is blind in exactly the case it
  exists for. The cap is configuration (002), not the literal three.

## Assumptions

- This specification owns the action catalogue, its execution, verification and undo. It does **not**
  own policy decisions, autonomy grants, budgets or approval lifecycle (002), diagnosis or the
  is-this-a-code-problem classifier (006), or the runner's packaging and transport (012). 002 decides
  whether an action may run; this feature decides what the action is and proves it can be undone.
- Verification windows and blast-radius limits are per-action, per-tenant configuration owned here;
  rate limits, cooldowns, attempt caps and the recurrence window are 002's (FR-013, C-11). **None of
  them is benchmark-derived.** They are tenant configuration tuned on the pilot and on the stage-0
  incident audit, tracked as a commitment in [S0-7](../../docs/stage-0.md), and they are deliberately
  *not* `threshold_derivation` rows: 011's `threshold_key` enum is closed around the four
  autonomy-governing numbers (false-fix rate, per-incident cost ceiling, per-tenant daily budget,
  escalation attempt cap), and a verification window or a replica bound governs no autonomy level. A
  wrong value here makes a remediation too eager or too timid; a wrong value there permits autonomy
  that was not earned, which is why only the second kind is constrained to a reproducible, real-only
  run (C-05).
- The v1 adapter set determines which actions are available to a given tenant; a catalogue action
  with no adapter for that tenant's platform is unavailable rather than partially implemented.
- Expected-improvement signals are supplied by the observability adapters (003); this specification
  consumes metric queries and does not define their collection.
- The deploy mechanism can enumerate prior versions and mark known-bad ones. Where it cannot,
  rollback is unavailable for that tenant rather than approximated.
- Autonomous execution of reversible actions remains the only autonomous production action in year
  one (D-14). Raising that set requires a constitution amendment, not configuration.
