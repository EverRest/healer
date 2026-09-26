# Tasks: Reversible production actions

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/openapi.yaml](contracts/openapi.yaml),
[contracts/action-catalogue.md](contracts/action-catalogue.md),
[contracts/events.md](contracts/events.md), [quickstart.md](quickstart.md)

**Prerequisites**: [012](../012-engineering-foundation/tasks.md) phases 1–2 and 6 — workflow machine,
callback registry, tenancy context, gate harness, and the closed boundary contract plus capability
resolution the `remediation_directive` rides on; [001](../001-issue-and-evidence/tasks.md) phase 2 —
evidence writer, producer attribution, audit entries; [002](../002-policy-and-autonomy/spec.md) —
policy decisions, autonomy grants, approval lifecycle, dry-run evaluation;
[006](../006-diagnosis/spec.md) — the diagnosis or correlation evidence a proposal must reference.

**Tests**: TDD is constitutional (Development Workflow). Every refusal and every undo gets a test
that is seen to fail first. An undo nobody has watched run is not an undo, and the attestation in
T022 is what makes that structural rather than aspirational.

**Organization**: one phase per user story. US1–US6 are P1; US7–US8 are P2 and are still pilot
blockers, because they are what happens when the safe action class stops being safe.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [ ] T001 Package `packages/domain/remediation` with the layer layout in [plan.md](plan.md), plus the `apps/runner/actions` module surface; entry surfaces declared (012 FR-001)
- [ ] T002 [P] Prisma models for schema `remediation` per [data-model.md](data-model.md); first migration, every table carrying `tenant_id` with its `(tenant_id, …)` index (FR-024)
- [ ] T003 [P] Platform ports — deployment, workload, feature flag, queue, job — split into a read-only handle type and a mutating handle type, so a dry-run cannot hold the second (R-10, plan Technical Context)

---

## Phase 2: Foundational (blocks US1–US8)

- [ ] T004 `remediation_attempt` state machine over 012's workflow machine, with exactly the transitions in [data-model.md](data-model.md) (012 T013, FR-011)
- [ ] T005 `verification_tick` callback registration through 012's callback registry; a tick is consumed idempotently and repeats are counted (012 T014, FR-011)
- [ ] T006 [P] `remediation_directive` and `remediation_result` as versioned Zod schemas extending the closed boundary shape set — no free-form string field (012 T040, FR-009, FR-025, [contracts/action-catalogue.md](contracts/action-catalogue.md))
- [ ] T007 [P] Evidence and audit wiring: proposal, result, each verification observation and each undo emits its own evidence link from the step that observed it, never reconstructed afterwards (001 T005, 001 T006, FR-023, 001 FR-008)
- [ ] T008 [P] `TenantContext` on every repository method; `remediation_target` resolution happens **within** the tenant, so a foreign target is unaddressable rather than filtered out (012 T010, FR-024)
- [ ] T009 `remediation_catalogue_version`: append-only publication of the content digest over every action definition, with `action_keys` as the closed set and the action key union in TypeScript (FR-001, R-01)
- [ ] T010 [P] Refusal is a result: every precondition, limit, eligibility, block, capability and policy refusal is recorded as an attempt in state `refused` with its reason and returned structured — never only a log line ([contracts/action-catalogue.md](contracts/action-catalogue.md), 002 FR-015)
- [ ] T011 [P] `RemediationProposed` publisher — attempt id, action key, target ref, catalogue version, parameters, blast radius, issue fingerprint, justification evidence and the policy decision, written in the same transaction as the `proposed` row ([contracts/events.md](contracts/events.md), FR-023, 012 T012)
- [ ] T012 [P] `RemediationDispatched` publisher — carrying `priorState`, `undoDirective` and `revisionRefAtDispatch`, published in the dispatch transaction so a consumer never sees a dispatch whose undo was not persisted ([contracts/events.md](contracts/events.md), R-05)
- [ ] T013 [P] `RemediationVerified` publisher — anchor, baseline, observed value, **`verificationEvidenceIds`** and `timeToVerifiedRemediationMs`; consumed by 001 to set `resolutionKind = remediated`, and by 009 through 001 to release held tickets, which is why the evidence identifier set is non-empty by construction (C-09, 001 `contracts/events.md`, 009 FR-018)
- [ ] T014 [P] `RemediationUndone` publisher — trigger, undo action key, state before and after, `observed`, evidence; consumed by 001 to reopen the issue (FR-006, [contracts/events.md](contracts/events.md))
- [ ] T015 [P] `RemediationEscalated` publisher — reason, last **observed** state, attempt history, recurrence intervals, evidence and any `targetBlockId`; consumed by 001 to move the issue to `needs_human`. This feature owns the payload and the transition and no transport (R-16)
- [ ] T016 `RemediationCataloguePublished` publisher — catalogue version, digest, action keys, build reference and `undoAttestations`; consumed by 002 to re-derive `reversible` and `hasTestedUndo`, which under C-18 is what gives `reversible_remediation` an autonomy level at all (C-09, C-18, R-02, 002 `contracts/evaluation.md`)

**Checkpoint**: the substrate exists; no action can yet be loaded, proposed or dispatched.

---

## Phase 3: US2 — Four declarations or it is not in the catalogue (Priority: P1) 🎯 MVP

**Goal**: six action definitions that either declare all four things and attest a passing undo on
this build, or do not load at all.

**Independent test**: quickstart 5, 6, 7, 8, 9, 10, 11, 12, 26, 27

- [ ] T017 **Test first**: remove the undo from an action definition → catalogue load rejects that action and it cannot be proposed (FR-002, SC-001, quickstart 6)
- [ ] T018 **Test first**: define an action whose verification baseline window overlaps `issue.first_seen_at` → rejected at catalogue load (FR-005, R-03, quickstart 5)
- [ ] T019 Action definition type: precondition, action, verification and undo all required; the anchor kind enum is `production_metric` · `pre_existing_healthcheck` · `pre_existing_test` with **no member for the action's own report and no free-form anchor field** (FR-002, FR-005, R-03, quickstart 4)
- [ ] T020 Catalogue loader validation implementing T017 and T018, rejecting per action rather than failing the whole load silently (FR-002, FR-005)
- [ ] T021 **Test first**: keep the undo test and change the action's code → the attestation no longer matches the build digest and the action does not load (R-02, quickstart 8)
- [ ] T022 Undo attestation as the admission gate: the undo test run writes the `undo_attestations` entry naming the catalogue digest, build reference, test run identifier and result, and the loader refuses an action whose attestation does not match the running build — this is what 012's `gate-undo` enumerates. The same entry is **the sole source of 002's `hasTestedUndo`**, published on `RemediationCataloguePublished` (T016), so under C-18 an unattested undo leaves `reversible_remediation` with no autonomy level rather than a stale permission (FR-003, C-18, 012 FR-014, 002 SC-005, quickstart 7)
- [ ] T023 **Test first**: name a deployment that is not in the target's own history, then assert the parameter schema has no image, tag, branch or version field at all — a forward deploy is not expressible by any caller (R-04, 002 FR-008, quickstart 9)
- [ ] T024 `deployment.rollback` definition: `{ targetId, previousDeploymentId }` where `previousDeploymentId` is resolved by the deployment adapter from the target's own deployment history and must precede the current deployment (R-04, FR-022, quickstart 9)
- [ ] T025 Rollback preconditions, re-evaluated immediately before execution: no prior deployment, prior deployment marked known-bad, irreversible schema migration in the range — each refused with the version or migration named (FR-004, FR-022, quickstart 10, 11, 12)
- [ ] T026 `deployment.restore_dispatch_version`: rollback's **undo-only** action key, with
  `{ targetId, revisionRef }` where `revisionRef` is validated equal to the attempt's
  `revision_ref_at_dispatch`, so it names exactly one deployment. Loadable and attested like every
  entry; **not proposable** — no proposal path accepts it, no eligibility row is written for it, and a
  **test** asserts both. Reusing `deployment.rollback` is inadmissible: its schema names a deployment
  *preceding* the current one, and the undo names the one that succeeded it (C-15, R-19, FR-022a)
- [ ] T027 [P] `workload.restart` definition: minimum healthy replica count and not-mid-rollout preconditions; undo `restore_prior_replica_state` — scale to the healthy count observed in the precondition, captured at dispatch — **triggered when the restart leaves fewer healthy replicas than the precondition observed**, with the R-18 attestation test (record a count, restart into a state with fewer, assert the undo restores it). "No undo is required because a restart is harmless" is how a restart loop becomes an outage ([contracts/action-catalogue.md](contracts/action-catalogue.md), R-18, quickstart 27)
- [ ] T028 [P] `feature_flag.disable` definition: flag marked remediable by the tenant, not a declared kill switch, not already disabled; undo restores the exact prior value and scope captured at dispatch. Its `pre_existing_test` anchor **executes in the customer's execution plane, in 007's sandbox, against the deployed revision's commit** — never in the control plane and never against production credentials; a tenant whose sandbox cannot reach the flag's evaluation path has only the metric anchor (FR-015, R-03, 007 FR-011, quickstart 25)
- [ ] T029 [P] `service.scale` definition: `{ targetId, replicaDelta }` — a delta, not an absolute count, so a bound is expressible; undo is the inverse delta against the replica count observed at dispatch (FR-014, R-12)
- [ ] T030 [P] `queue.drain` definition: `{ targetId, maxMessages, holdingRef }` — move to holding, **no delete field exists in the schema**; undo restores the moved messages in order by the batch identifier recorded at dispatch. The "holding destination writable" precondition is the queue adapter's **`probeHolding`** check — write a canary message, read it back, delete it — recorded in `prior_state`; an unprobed or failing destination refuses the action, because a drain into an unwritable destination is the deletion FR-021 forbids arriving by another route (FR-021, quickstart 26)
- [ ] T031 [P] `job.retry` definition: terminal-stuck, not running, tenant-declared idempotent, retry count below cap; undo cancels the retried execution and restores the prior job state. Its verification anchors on the **consumer error rate for the job's queue or a downstream completion metric against a pre-incident baseline**, or `pre_existing_healthcheck` on the consumer — **never on the job reaching a terminal success state**, which is the action's own output, breaches FR-005, and has no member in the closed `anchor_kind` enum, so the loader would reject the entry. The job's terminal state is a precondition for *closing* the window (FR-002, FR-005, R-03, [contracts/action-catalogue.md](contracts/action-catalogue.md))
- [ ] T032 The common preconditions every action inherits — eligibility (opt-in **and** declarations), no open block, target not busy, runner capability, policy, justification — evaluated in that order and returning the declared refusal code. **Rate, cooldown and attempt cap are not among them**: they are evaluated inside the policy decision and surface here as projected reason codes (C-11, [contracts/action-catalogue.md](contracts/action-catalogue.md), FR-004, FR-013, FR-015, FR-018)
- [ ] T033 [P] Continuous check `check:undo-attestation` — every loadable action attests a passing undo on this build (R-02, SC-001)

**Checkpoint**: the catalogue is closed, admitted by execution rather than by inspection, and a
forward deploy has nowhere to live.

---

## Phase 4: US4 — The control plane decides, the customer's plane acts (Priority: P1)

**Goal**: one dispatch channel, schema-validated, idempotent, with no shell anywhere on it.

**Independent test**: quickstart 16, 21, 36, 37, 41, 42, 43

- [ ] T034 **Test first**: audit the runner's action surface for a generic command, script or manifest endpoint → none exists; every action is a named schema with validated parameters (FR-009, SC-006, quickstart 16)
- [ ] T035 `apps/runner/actions/<actionKey>` modules exporting `plan()` and `apply()`, one per catalogue key, bound to the control-plane definition by the action key and its parameter schema (FR-009, plan structure decision)
- [ ] T036 `DispatchAction` over the `remediation_directive`: `invocationId`, mode, action key, catalogue digest, target ref, schema-validated parameters, blast-radius and timeout limits — and nothing else (FR-009, T006, [contracts/action-catalogue.md](contracts/action-catalogue.md))
- [ ] T037 `DispatchAction` takes a `RemediationDispatchCapability` as an argument and resolves one
  from **no** container, module import, ambient configuration or global, per
  [ADR 0008](../../docs/adr/0008-capability-passing.md); a **test** asserts the absence, not a refused
  call, so a run without the capability cannot reach dispatch rather than choosing not to (FR-009,
  011 R-01, 011 T014)
- [ ] T038 **Test first**: deliver the same `invocationId` twice, and the same result event twice → exactly one applied effect and no double-apply in either case (FR-010, SC-007, quickstart 21, 37)
- [ ] T039 Idempotency by `invocation_id` on dispatch and on result ingestion, implementing T038 (FR-010)
- [ ] T040 Remediation capabilities are state-changing: a runner that does not declare the capability for an action causes refusal with a stated reason and the catalogue reports the action unavailable — never a degraded execution (R-14, 012 T043, 012 FR-018, quickstart 41)
- [ ] T041 [P] Result ingestion: `remediation_result` validated independently at ingress; prior state, observed state, metric deltas and operation identifiers only — no raw log bodies, manifests, command output or drained message contents (FR-025, quickstart 42)
- [ ] T042 Reconciliation after connectivity loss: on reconnect the action's state is read back from the target by invocation identifier, never assumed from the dispatch record (FR-010, edge case, quickstart 36)
- [ ] T043 e2e isolation matrix across every action type: another tenant's attempt, target, block and history read return 404, and dispatch against their target finds no resolvable target (FR-024, SC-009, quickstart 43)

**Checkpoint**: the only way to reach the customer's plane is a named schema, and it applies once.

---

## Phase 5: US3 — Dry-run before anything moves (Priority: P1)

**Goal**: a complete plan for every action, produced by a call path that holds nothing capable of
mutating.

**Independent test**: quickstart 13, 14, 15

- [ ] T044 **Test first**: run every catalogue action in dry-run against a live environment → zero state changes in **the environment's own audit log**, not in ours (SC-005, quickstart 13)
- [ ] T045 **Test first**: inspect the dry-run call path → the read-only platform handle's type has no mutating method, so `apply()` is unreachable rather than merely unreached (R-10, quickstart 14)
- [ ] T046 `plan()` against the read-only handle from T003, producing the resolved target, the exact operation, the observed current state, the blast radius, the verification plan and the undo plan (FR-007, R-10)
- [ ] T047 `POST /remediation/dry-run` returning `RemediationPlan`, with the policy decision coming from 002's dry-run evaluation and naming the rules that produced it (FR-007, 002 FR-019, [contracts/openapi.yaml](contracts/openapi.yaml))
- [ ] T048 [P] A dry-run whose precondition does not hold reports the failing precondition instead of a plan (FR-007, quickstart 15)
- [ ] T049 [P] The undo plan shown in a dry-run and in an approval request is the same resolved object later persisted at dispatch — one shape, three readers (R-05, 002 FR-015)

**Checkpoint**: a tenant can inspect every action before granting anything, and the inspection path
cannot execute.

---

## Phase 6: US1 — Rollback, verified, or undone (Priority: P1)

**Goal**: the loop that produces v1's measurable time saving — dispatch, verify against a
pre-incident anchor, undo automatically when the improvement does not appear.

**Independent test**: quickstart 1, 2, 3, 4, 35, 38, 45

- [ ] T050 **Test first**: dispatch an action and assert that `prior_state` and `undo_directive` were both written in the same transaction as the dispatch, with fully literal parameters, before the mutation left the control plane (R-05, FR-006, data-model invariant)
- [ ] T051 `DispatchAction` persisting the observed prior state, the fully resolved undo directive and `revision_ref_at_dispatch` in one transaction, then dispatching — the undo is never recomputed later (R-05, R-13)
- [ ] T052 **Test first**: force the signal to stay elevated → the undo runs automatically and the issue is reopened; then break the metric source → the window closes `inconclusive` and the undo runs identically. Both paths, one behaviour (FR-006, SC-003, quickstart 2, 3)
- [ ] T053 `verification_window` created at dispatch with a baseline window that closes before `issue.first_seen_at`, re-checked at dispatch and not only at catalogue load (FR-005, R-03, quickstart 5)
- [ ] T054 `EvaluateVerificationTick`: each tick samples the anchor and writes the observation as a `metric_delta` or `test_result` evidence record emitted by the verification step, linked with `conclusion_type = 'remediation'`; the window closes `improved`, or at the deadline `not_improved` or `inconclusive` (FR-005, FR-006, R-06, 001 T005, quickstart 4)
- [ ] T055 Automatic undo on `not_improved` **or** `inconclusive`, dispatching the stored directive verbatim with `mode: "undo"` (FR-006, R-05, quickstart 2, 3)
- [ ] T056 Issue reopened on `undone`; the verification path asserted to be persisted state plus callback, with lint failing on a sleep or poll loop in a processor (FR-011, 012 FR-025, 012 FR-026, quickstart 38)
- [ ] T057 **Test first**: change the target's platform revision from outside during the verification window → the verification is invalidated and escalated, and the observed outcome is **not** attributed to the remediation (FR-020, R-13, quickstart 35)
- [ ] T058 External-change detection by the platform's own revision counter, re-read on every tick and compared against our invocation identifier, implementing T057 (FR-020, R-13)
- [ ] T059 [P] `time_to_verified_remediation_ms` recorded per attempt when the window closes `improved`; the column is named for what it measures and is never aggregated into a product-wide MTTR figure (R-15, D-19a, quickstart 45)
- [ ] T060 Full US1 e2e: replay a deploy-correlated regression in staging → proposal, recorded policy decision, runner execution, verification against a baseline taken before the deploy, and a forced non-improvement triggering the undo and the reopen (quickstart 1, SC-003)

**Checkpoint**: an action executes, proves itself against something that pre-dates the incident, or
undoes itself.

---

## Phase 7: US5 — Autonomous only where autonomy was granted (Priority: P1)

**Goal**: every execution carries a recorded decision, and the grant matrix is the safety boundary.

**Independent test**: quickstart 17, 18, 19, 20, 40

- [ ] T061 **Test first**: attempt to reach dispatch without a policy decision → no path exists; a reconciliation over every `execute` attempt finds zero without `policy_decision_id` (FR-008, SC-002, quickstart 17)
- [ ] T062 Policy evaluated before every execute attempt, the decision recorded with its rule version, and `mode = 'execute'` without `policy_decision_id` rejected by the schema rather than by a handler (FR-008, 002 FR-001, 002 FR-017)
- [ ] T063 [P] A missing grant refuses naming the missing grant; no matching rule is `DENY` — absence never permits a production action (002 FR-005, 002 FR-007, SC-004, quickstart 18, 19)
- [ ] T064 [P] `REQUIRE_APPROVAL`: the request shows the action, the reason, the evidence, the blast radius and the undo plan, and a grant revoked during `awaiting_approval` stops the guarded step (002 FR-007, 002 FR-015, quickstart 20)
- [ ] T065 `justificationEvidenceIds` required at proposal and resolved against 006's diagnosis or correlation evidence; a proposal with none is refused `JUSTIFICATION_MISSING` (FR-018, 001 FR-009, quickstart 40)
- [ ] T066 [P] Continuous check `check:remediation-policy` — every executed attempt has a recorded policy decision (SC-002)

**Checkpoint**: nothing executes outside a granted scope, and every refusal is legible to the tenant.

---

## Phase 8: US8 — Blast radius is declared and bounded (Priority: P2)

**Goal**: the refusals that keep a correct action from being applied to the wrong thing, at the wrong
size, at the wrong moment.

**Independent test**: quickstart 22, 23, 24, 25

- [ ] T067 **Test first**: two proposals against one target at the same instant → the second is refused `TARGET_BUSY` by the unique partial index, not by a lock that could expire during the action it protects (FR-012, R-07, quickstart 22)
- [ ] T068 Unique partial index `(tenant_id, target_id) where state in ('dispatched','awaiting_verification')`, and the refusal path that names the in-flight attempt; dry-runs are deliberately not covered (FR-012, R-07)
- [ ] T069 **Test first**: a scale request exceeding `maxReplicaDelta` → refused with the limit named, **never truncated to fit** (FR-014, R-12, quickstart 23)
- [ ] T070 Blast-radius computation at proposal against the architecture graph, where an unconfirmed edge may only widen the radius and never narrow it (FR-014, R-12, C-03, 004 FR-015, 004 FR-016a)
- [ ] T071 [P] `remediation_target_eligibility` as opt-in per target and per action, created only by a tenant action; absence is refusal and there is no default-eligible flag (FR-015, R-12, quickstart 24, 25)
- [ ] T072 Per-target declaration columns on `remediation_target` — `min_healthy_replicas`,
  `min_replicas`, `max_replicas`, `remediable_flag_keys`, `holding_destination`,
  `idempotency_declared` — nullable, where **null is undeclared, not zero and not false**; and
  eligibility evaluated as the **conjunction** of a stored opt-in row and every declaration the action
  requires. A **test** per action asserts that an opt-in without its declaration, and a declaration
  without its opt-in, both refuse `TARGET_NOT_ELIGIBLE` (FR-015, R-17, data-model)
- [ ] T073 [P] `remediation_action_bound` — blast radius and verification window only — as deterministic functions over stored bounds, with the existence of each bound not configurable. **`remediation_limit` is deleted**: rate per hour, cooldown, attempt cap and the recurrence window are 002's, evaluated inside the policy decision over the `targetRef` and `fingerprint` supplied on `DecisionInput`, and appear here only as projected refusal reason codes `RATE_LIMITED` · `COOLDOWN` · `ATTEMPT_CAP`. A **test** asserts this schema stores none of the four (FR-013, C-11, IV)
- [ ] T074 [P] Continuous check `check:target-serialisation` — at most one live mutation per target (R-07, FR-012)

**Checkpoint**: an action applies only where a human opted in, and only at a size that was evaluated.

---

## Phase 9: US6 — A remediation that keeps being needed is a signal (Priority: P1)

**Goal**: the restart loop escalates instead of continuing, and it escalates even though each
recurrence creates a new issue.

**Independent test**: quickstart 28, 29, 30, 39

- [ ] T075 **Test first**: induce a failure that a restart relieves for twenty minutes, three times → the third attempt is refused and the escalation carries three attempts, their intervals and each attempt's evidence (FR-016, SC-011, quickstart 28)
- [ ] T076 **Test first**: make each recurrence fall outside the reopen window so each creates a **new** issue → the cap still fires, because the counting key is `(target, fingerprint)` and not the issue (R-08, 001 FR-005, quickstart 29)
- [ ] T077 `targetRef` and `fingerprint` supplied on every `DecisionInput`, so **002** evaluates the attempt cap and cooldown over `(tenant_id, target_id, issue_fingerprint)` within its rolling recurrence window; `issue_fingerprint` is copied at proposal, the issue identifier is recorded but never counted on, and the refusal is recorded under 002's reason code (FR-013, FR-016, R-08, C-11, 002 `contracts/evaluation.md`)
- [ ] T078 **Test**: build one `(target, fingerprint)` group from attempts under three different
  action keys with different `attempt_cap` values → the governing cap is the **minimum** over the keys
  present, and the group escalates there. Taking the maximum, or the proposed action's own cap, lets an
  operator extend a loop indefinitely by alternating actions (FR-016, R-08, SC-011)
- [ ] T079 `GetRemediationHistory` as a query over the `(tenant_id, target_id, issue_fingerprint, proposed_at)` index; there is no history table (FR-016, VIII, [contracts/openapi.yaml](contracts/openapi.yaml))
- [ ] T080 Recurrence escalation payload: every attempt in the group, the recurrence intervals and the per-attempt evidence — the pattern is the diagnosis (FR-016, quickstart 28)
- [ ] T081 [P] A proposal inside the cooldown is refused until it elapses (FR-013, 002 FR-014, quickstart 30)
- [ ] T082 A verified attempt sets `mitigation = true` and never closes an issue classified as a code problem; the issue returns to its investigation state carrying `mitigated_at` and the code path continues (FR-017, R-11, quickstart 39)

**Checkpoint**: the system can no longer keep a broken component alive without paging anybody.

---

## Phase 10: US7 — When the undo fails (Priority: P2)

**Goal**: the one event that turns this action class unsafe stops everything, and says what it
observed rather than what it intended.

**Independent test**: quickstart 31, 32, 33, 34

- [ ] T083 **Test first**: make the undo fail → both the verification failure and the undo failure are recorded as evidence, escalation is immediate, a `target_block` opens, and no further automated attempt occurs (FR-019, SC-008, quickstart 31)
- [ ] T084 `undo_record` with `observed = false` when the state could not be read, and `undo_failed` as a terminal attempt state that opens a `target_block` with its reason, attempt and evidence references (FR-019, R-09)
- [ ] T085 [P] While a block is open, **every** action against that target is refused at proposal — not only the one that failed (R-09, quickstart 32)
- [ ] T086 [P] The escalation reports the target's last observed state, and says the state is unreadable where it is, rather than reporting the intended state (R-09, quickstart 33)
- [ ] T087 `POST /remediation/blocks/{targetId}/clear` recording the named human and the note in the audit trail; no automatic clearing path exists (FR-019, quickstart 34)
- [ ] T088 [P] Continuous check `check:open-blocks` — no automated attempt exists after an open block (SC-008)

**Checkpoint**: after an undo failure the system is stopped, blocked and honest about what it left
behind.

---

## Phase 11: Polish and cross-cutting

- [ ] T089 [P] `GET /remediation/catalogue` reporting per-tenant availability, the unavailable reason, the blast-radius dimension and `undoAttestedAt` (FR-001, R-14, [contracts/openapi.yaml](contracts/openapi.yaml))
- [ ] T090 [P] `GET /remediation/attempts`, `/remediation/attempts/{attemptId}`, `/remediation/history` and `/remediation/blocks` read surfaces ([contracts/openapi.yaml](contracts/openapi.yaml))
- [ ] T091 [P] Audit completeness check: for any attempt, actor, action, target, parameters, policy decision, evidence references and outcome all resolve (FR-023, 001 FR-012, quickstart 44)
- [ ] T092 [P] Regenerate `contracts/openapi.json` and check for drift against the committed artifact (012 FR-010)
- [ ] T093 SC-010 computed over **live tenant data at L2 or above** — median `time_to_verified_remediation` for deploy-correlated regressions against median time to a merged code fix for the same on that tenant, "materially shorter" being *at most half* — reported with an availability tri-state (`available` · `insufficient_observation` · `not_applicable`) and its reason, of the same shape as 011's `revert_rate_30d`. It is **not** handed to 011: a simulation dispatches no remediation and merges nothing, so neither population exists in a replay and 011's closed `threshold_key` enum has no member for it (SC-010, R-15, D-19a, 011 R-09, quickstart 45)
- [ ] T094 Run the whole of [quickstart.md](quickstart.md) — all 45 scenarios including the refusals, plus the four invariant checks

---

## Dependencies

```text
012 phases 1–2 + 6 · 001 phase 2 · 002 · 006
   └─▶ Phase 1 (T001–T003)
          └─▶ Phase 2 (T004–T016)
                 ├─▶ Phase 3 · US2 (T017–T033)  ← blocks every other story
                 │      ├─▶ Phase 4 · US4 (T034–T043)
                 │      │      └─▶ Phase 5 · US3 (T044–T049)
                 │      ├─▶ Phase 7 · US5 (T061–T066)
                 │      └─▶ Phase 8 · US8 (T067–T074)
                 └─▶ Phase 6 · US1 (T050–T060) ← needs Phase 4 and Phase 7
                        ├─▶ Phase 9 · US6 (T075–T082)
                        └─▶ Phase 10 · US7 (T083–T088)
Phase 11 (T089–T094) last
```

**Explicit dependencies beyond phase order**

- T022 is what makes 012's `gate-undo` (012 FR-014) enableable — the gate enumerates this catalogue,
  so the attestation has to exist before the gate can pass on anything.
- T006 depends on 012's closed boundary schema set (012 T040): `remediation_directive` is an entry in
  that set, not a parallel channel with its own validation.
- T004 and T005 depend on 012's workflow machine and callback registry (012 T013, 012 T014).
- T040 depends on 012's capability resolution (012 T043): remediation capabilities are
  state-changing, so a gap refuses rather than degrades — the read-only degrade path is the wrong one
  here.
- T053 needs `issue.first_seen_at` from 001, and T054 needs 001's evidence writer and producer
  attribution (001 T005, 001 T006).
- T062, T063 and T064 need 002's decision, grant and approval records. Until 002 lands, T061's
  assertion is about the absence of a bypass path and can be written against code that does not exist
  yet — which is the cheapest moment to write it.
- T065 needs 006's diagnosis or correlation evidence to reference.
- T050 and T051 come before anything in Phases 9 and 10: the `undo_directive` row they write is what
  both phases exercise.
- T070 needs 004's blast-radius query; until it exists the radius is the target's own declared
  dimension and the widening rule is tested against a stub graph.
- T016 (`RemediationCataloguePublished`) must land with T022, because C-18 makes the attestation the
  only thing that gives `reversible_remediation` an autonomy level: a catalogue published without the
  payload leaves 002 deriving `hasTestedUndo` from nothing.
- T013 (`RemediationVerified`) is what 001 turns into `IssueResolved(remediated)` and what 009 releases
  held tickets on, so its `verificationEvidenceIds` must be non-empty by construction (C-09).
- T026 (the undo-only key) precedes T051 and T055: the undo directive persisted at dispatch names that
  key, and dispatching it is what Phase 6's automatic undo does.
- T072 (per-target declarations) precedes T071. Eligibility is the conjunction of the opt-in row and the
  declarations, so writing the opt-in path first gives an eligibility rule that is half a rule.

## Parallel groups

- Setup: T002, T003 together.
- Foundational: T006, T007, T008, T010 after T004–T005; then the publishers T011–T016 together.
- Catalogue: T027–T031 together — one module per action key, five separate files; T026 with T025.
- US4: T041 alongside T042.
- Dry-run: T048, T049 after T046–T047.
- US5: T063, T064, T066.
- US8: T071, T073, T074.
- US7: T085, T086, T088.
- Polish: T089–T092.

## Strategy

1. **Phase 3 (US2) before every other story.** An action that does not load cannot be proposed,
   planned, dispatched or verified, so the catalogue is the only sensible first story. It is also the
   cheapest moment for T022: attesting six undos as they are written costs a day, and retrofitting
   attestation onto a year of definitions is where a gate gets disabled instead of fixed.
2. **US4 before US3 and US1**, because the directive is the only route into the customer's plane and
   both dry-run and execute are modes of it. Building the dry-run over a direct adapter call first
   would create a second path to production, and the second path is the one nobody audits.
3. **US3 before US1.** Dry-run is how a tenant grants autonomy the first time and it is what 011
   replays, so it earns its place ahead of execution. It also exercises the read-only handle before
   any code in this feature holds a mutating one.
4. **US5 with US1, and T061 first inside it.** "No path exists that dispatches without a decision" is
   an assertion about code that has not been written; making it now is trivial and making it later
   means proving a negative about an existing call graph.
5. **US1 next** — the loop the feature exists for, and the phase that writes `prior_state` and
   `undo_directive`. Everything in Phases 9 and 10 reads those two columns.
6. **US8 alongside US1**, staffed separately if there is capacity: serialisation, blast radius and
   eligibility are all refusals at proposal time and touch none of the verification loop.
7. **US6 and US7 last of the stories**, because neither is reachable until an action has actually run.
   P2 here does not mean optional for the pilot: US6 is what stops the product becoming a
   symptom-masking machine, and US7 is what stops a failed undo from being followed by a sixth
   automated attempt against a target in an unknown state.
8. **Phase 11 before the pilot.** The full quickstart, weighted as it is toward the refusals, is the
   artifact a customer's change-management process reads.
