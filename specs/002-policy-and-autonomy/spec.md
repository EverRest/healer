# Feature Specification: Policy engine, autonomy levels and budgets

**Feature Branch**: `002-policy-and-autonomy`

**Created**: 2026-09-23

**Status**: Draft

**Input**: Deterministic, versioned control over what the system is permitted to do — per tenant, per component, per environment, per issue type, per action — plus the cost budgets and stop rules that bound every AI path. The model proposes; policy decides.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The model proposes, policy decides (Priority: P1)

An agent concludes a patch is safe and should be merged. Policy evaluates the proposal against
rules the customer configured — component, environment, what the change touches, the tenant's
autonomy level — and returns `ALLOW`, `DENY` or `REQUIRE_APPROVAL`. The agent's opinion of its own
work is not an input to that decision.

**Why this priority**: Principle IV. This is the component that makes everything else safe to
build, which is why it exists before anything that writes.

**Independent Test**: submit proposals with identical payloads but different declared confidence →
identical policy decisions.

**Acceptance Scenarios**:

1. **Given** a proposed action, **When** policy evaluates it, **Then** the decision depends only on
   structural facts — action type, target, environment, autonomy level, evidence completeness — and
   never on a model-reported confidence value.
2. **Given** two proposals identical except for declared confidence, **When** both are evaluated,
   **Then** both receive the same decision.
3. **Given** any decision, **When** it is made, **Then** an audit entry records the rule version,
   the inputs and the outcome.
4. **Given** an action with no matching rule, **When** policy evaluates it, **Then** the result is
   `DENY` — absence of a rule is never permission.

---

### User Story 2 - Autonomy is granted in increments the customer controls (Priority: P1)

A platform lead enables diagnosis everywhere, pull requests for two non-critical components in
staging, and autonomous rollback in production for one service. Nothing else is permitted. Each
grant is separate, visible, and revocable in one action.

**Why this priority**: autonomy is a relationship, not a switch. A product that only offers global
levels cannot be adopted by anyone who has something to lose.

**Independent Test**: configure a mixed autonomy matrix → each action is permitted exactly where
granted and refused everywhere else.

**Acceptance Scenarios**:

1. **Given** autonomy granted for one component, **When** the same action is proposed for another,
   **Then** it is refused with the reason naming the missing grant.
2. **Given** a grant is revoked, **When** an in-flight workflow reaches the guarded step,
   **Then** it stops and requires approval — revocation applies immediately, not at next start.
3. **Given** the year-one ceiling, **When** any configuration attempts to permit merge, deploy or
   autonomous remediation beyond the allowed set, **Then** it is rejected by a system-level limit
   the tenant cannot raise.

---

### User Story 3 - Reversible actions are governed separately (Priority: P1)

Rollback, restart, feature-flag disable and scale are treated as a different risk class from code
changes: they can be autonomous at a level where patching still requires a human, because being
wrong costs a deploy rather than a codebase.

**Why this priority**: this is where MTTR improvement actually comes from in v1, and the safety
argument is genuinely different.

**Acceptance Scenarios**:

1. **Given** an action classified as reversible with a declared undo, **When** autonomy permits it,
   **Then** it may execute without human approval.
2. **Given** an action with no declared undo, **When** it is proposed as reversible, **Then** it is
   rejected — reversibility must be demonstrable, not asserted.
3. **Given** a reversible action executed, **When** its verification window elapses without the
   expected improvement, **Then** the undo runs automatically and the issue is reopened.
4. **Given** repeated remediation of the same issue, **When** the attempt limit is reached,
   **Then** further attempts are refused and a human is escalated to.

---

### User Story 4 - Cost is bounded and degradation is declared (Priority: P1)

A misconfigured alert rule fires four hundred times overnight. The tenant's budget absorbs the
first portion, degrades to cheaper handling, then stops and queues the rest for a human. Nobody
wakes up to an unbounded bill.

**Why this priority**: an unbounded AI spend path is a production incident of its own, and this
product has several.

**Acceptance Scenarios**:

1. **Given** an issue exceeds its per-issue budget, **When** the next AI step is requested,
   **Then** it is refused and the issue is marked as budget-limited with what was completed.
2. **Given** a tenant approaches the daily budget, **When** the soft threshold is crossed,
   **Then** the declared degradation order applies — cheaper tier, reduced context, diagnosis-only —
   in that order, and the degradation is recorded as an evidence record.
3. **Given** escalation to a stronger tier after failure, **When** the attempt cap is reached,
   **Then** escalation stops and the accumulated evidence and ruled-out hypotheses go to a human.

---

### User Story 5 - Approvals are reviewable, not rubber stamps (Priority: P2)

When policy returns `REQUIRE_APPROVAL`, the approver sees what will happen, why, the evidence
behind it, what it touches, and how to undo it — before deciding.

**Acceptance Scenarios**:

1. **Given** a pending approval, **When** it is displayed, **Then** it shows the proposed action,
   the reason, evidence references, impact summary and rollback plan.
2. **Given** an approval is not acted on within its expiry, **When** the expiry passes, **Then** the
   request lapses and the workflow stops rather than proceeding by default.
3. **Given** an approval is granted, **When** the action executes, **Then** the audit entry records
   which human approved it and against which policy version.

---

### Edge Cases

- Policy rules are edited while a workflow is mid-flight → the decision uses the version in force
  at evaluation time, and the version is recorded; re-evaluation at a later step may differ and
  that difference is visible.
- Conflicting rules match → the most restrictive outcome wins, deterministically, and the conflict
  is surfaced to the tenant as a configuration warning.
- Budget exhausted mid-workflow → the workflow suspends in a resumable state rather than failing;
  work already done is not discarded.
- An approver is unavailable → the request expires; there is no implicit delegation.
- A reversible action's undo itself fails → the issue escalates immediately with both failures
  recorded; no further automated attempts.
- Clock or budget-window boundary is crossed during evaluation → the window in force at request
  time applies, so a long workflow cannot gain budget by straddling midnight.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST evaluate every mutating action against the policy engine before execution.
  An action path that can bypass evaluation MUST NOT exist.
- **FR-002**: Policy decisions MUST be deterministic: identical inputs produce identical outcomes,
  with no model call in the decision path.
- **FR-003**: Model-reported confidence MUST NOT be an input to any policy predicate. Predicates
  MUST use structural facts — action type, target, environment, autonomy grant, evidence
  completeness, the code-problem verdict and fix-eligibility view (006, C-08), impact classification
  including the impact closure (004), budget state, and the limit counts of FR-014.
- **FR-004**: Policy rules MUST be versioned, and every decision MUST record the rule version used.
- **FR-005**: Absence of a matching rule MUST result in `DENY`.
- **FR-006**: Conflicting matching rules MUST resolve to the most restrictive outcome, and the
  conflict MUST be reported to the tenant as a configuration warning.
- **FR-007**: Autonomy MUST be grantable per tenant, per component, per environment, per issue type
  and per action, and MUST be revocable with immediate effect on in-flight workflows.
- **FR-008**: System MUST enforce a product-level autonomy ceiling that a tenant cannot exceed
  through configuration. For the current release the ceiling is: no merge, no **forward**
  deploy, and no autonomous action other than declared reversible remediations. Rollback to a
  previously deployed version is a reversible remediation (010), not a forward deploy, and is
  governed by FR-009 and FR-010 rather than by this ceiling.
- **FR-008a**: A change that **raises** the ceiling for an action class — giving a level to an action
  class that has none, or increasing an existing level — MUST cite a `threshold_derivation` (011
  FR-021b) that the build can resolve without a control-plane database, and the change MUST fail closed
  where it cannot be resolved (012 `gate-ceiling`, R-15). `ACTION_CEILING` stays a pure function with
  no configuration input: the citation governs the **edit** to the function, not its evaluation. Nothing
  about the ceiling is readable from configuration at runtime, so this requirement adds no branch to the
  evaluation path.
- **FR-009**: System MUST classify actions as reversible or irreversible. An action MUST NOT be
  treated as reversible unless it declares a precondition, an action, a verification and an undo.
  An action whose undo has not passed an automated test in the current release MUST have **no
  autonomy level at all**: the product ceiling is a function of the action class and of that
  attestation, enforced both at grant time and in the evaluation clamp (C-18).
- **FR-010**: Every executed reversible action MUST have a verification window; failure to observe
  the expected improvement within it MUST trigger the undo automatically and reopen the issue.
- **FR-011**: System MUST enforce a per-issue budget and a per-tenant period budget covering model
  spend and execution time, and MUST refuse further AI steps when either is exhausted.
- **FR-012**: System MUST apply a declared degradation order at the soft budget threshold, and MUST
  record each degradation as an evidence record with its reason.
- **FR-013**: System MUST cap escalation attempts. On reaching the cap it MUST hand off to a human
  with the accumulated evidence, attempted hypotheses and reasons for rejection. The attempt count is
  the escalation attempts recorded on the workflow run (012) and reaches the evaluator as an input,
  never as a counter this feature maintains.
- **FR-014**: System MUST enforce rate limits, cooldowns and attempt caps per action type, per target
  and per issue fingerprint, so that repeated automated action against the same target is bounded.
  **This is the only enforcement point** for those limits: a consuming feature (010) holds no limit
  store of its own and projects only the refusal reason codes, because two enforcement points with
  two stores and two keys disagree and neither is authoritative (C-11).
- **FR-015**: `REQUIRE_APPROVAL` MUST produce an approval request containing the proposed action,
  reason, evidence references, impact summary and rollback plan.
- **FR-016**: Approval requests MUST expire. An expired request MUST stop the workflow, never
  permit the action by default.
- **FR-017**: Every policy decision and every approval MUST be written to the audit trail with
  inputs, rule version, decision, and for approvals the identity of the human.
- **FR-018**: Policy configuration MUST be scoped by `tenantId`, and a tenant MUST NOT be able to
  read or affect another tenant's policy.
- **FR-019**: System MUST provide a dry-run evaluation that returns the decision and the rules that
  produced it, without executing anything, for use by the simulator (011) and by tenants testing
  configuration changes.
- **FR-020**: A change to policy configuration MUST itself be audited, recording who changed what.
- **FR-021**: The escalation attempt cap and the per-issue and per-tenant budgets MUST have product
  bounds that tenant configuration cannot cross — a maximum on the cap, a maximum on each budget — written
  as literals with constants in code and a test asserting the two agree. These are not tuning knobs but
  **stop rules**: a cap raised without limit is an agent that never stops escalating, and a budget raised
  without limit is a cost incident with no ceiling. Every unset value in this feature also ships a starting
  value chosen to fail closed ([stage 0 S0-7](../../docs/stage-0.md)).

### Key Entities

- **PolicyRule**: versioned condition and outcome. Matches on action type, target scope,
  environment, impact classification and evidence state; yields `ALLOW` | `DENY` |
  `REQUIRE_APPROVAL`.
- **AutonomyGrant**: tenant, scope (component / environment / issue type), action, level, granted
  by, granted at, revoked at.
- **ActionProposal**: what an agent wants to do — action type, target, payload reference, impact
  classification, evidence references. The input to evaluation.
- **PolicyDecision**: proposal, rule version, outcome, reasons, timestamp.
- **ApprovalRequest**: decision, presented summary, expiry, resolution, approver.
- **Budget**: scope (issue | tenant), period, limits for spend and time, consumption, thresholds.
- **ReversibleActionDefinition**: action type, precondition, verification, undo, rate limit,
  cooldown, attempt limit.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 mutating actions execute without a recorded policy decision, verified continuously
  by reconciling executed actions against decisions.
- **SC-002**: Identical proposals differing only in declared confidence receive identical decisions
  in 100% of test cases.
- **SC-003**: 100% of policy decisions resolve to a retrievable rule version.
- **SC-004**: 0 configurations can be created that exceed the product-level autonomy ceiling.
- **SC-005**: Every reversible action in the catalogue has a tested undo, verified by an automated
  check that fails if an action lacks one.
- **SC-006**: Under an induced flood of issues, tenant spend stays within the configured period
  budget, with degradation applied in the declared order.
- **SC-007**: 0 approval requests result in the action proceeding after expiry.
- **SC-008**: 0 cross-tenant policy reads or writes succeed in the isolation test matrix.
- **SC-009**: 0 changes raising a ceiling level reach the default branch without a resolvable
  derivation citation — a fixture branch that raises a level with no citation, with an unresolvable one,
  and with one whose artifact digest disagrees fails the gate in all three cases (FR-008a).

## Assumptions

- Starting budget values and attempt caps are placeholders until the stage-0 benchmark exists; they
  are configuration and are expected to change once false-fix rate and cost per resolved issue are
  measured.
- Impact classification is produced by 008 (change and verification) and consumed here; this
  specification does not compute it.
- This specification **owns the predicate vocabulary**, including the closure-shaped predicates over
  004's `ImpactClosure`. The operator-domain table in
  [contracts/evaluation.md](contracts/evaluation.md) is the single authority; 004 contributes fields
  and references that table, and the operator enum in the OpenAPI document is generated from it
  (C-19).
- Approval delivery (in-app, chat, email) is a notification concern; this specification defines the
  request, its contents and its lifecycle, not the channel.
- The autonomy ceiling in FR-008 is expected to be raised per action class once measured data
  supports it, through a constitution amendment rather than configuration.
