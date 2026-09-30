# Tasks: Policy engine, autonomy levels and budgets

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/openapi.yaml](contracts/openapi.yaml),
[contracts/evaluation.md](contracts/evaluation.md), [quickstart.md](quickstart.md)

**Prerequisites**: [012](../012-engineering-foundation/tasks.md) phases 1–2 — workflow machine,
callback registry, outbox, tenancy context, gate harness, `agent_run` and `tenant_budget`.
[001](../001-issue-and-evidence/tasks.md) phase 2 — the evidence substrate and the audit trail this
feature writes its degradation records and its decisions into.

**Tests**: TDD is constitutional (Development Workflow), not optional. Every guard here — default
deny, the ceiling, the epoch, the ex-ante charge, the expiry — gets a test that is **seen to fail
first**. A guard nobody has watched fire is a guard nobody knows works.

**Organization**: one phase per user story. US1–US4 are P1; US1 blocks every feature that writes.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 Package `packages/domain/policy` with its entry surface and the layer layout of [plan.md](plan.md) (012 FR-001) — _layer layout materialised as later tasks landed real files; no placeholder scaffolding (025566c)_
- [x] T002 [P] Prisma models for schema `policy` per [data-model.md](data-model.md) — `policy_ruleset`, `policy_rule`, `policy_action`, `autonomy_grant`, `autonomy_epoch`, `policy_decision` (including `target_ref` and `fingerprint`), `approval_request`, `budget_limit`, `action_limit`, `budget_degradation_mark`; first migration (025566c, FK to `policy_action` added in db8b452)
- [x] T003 [P] Database rules rejecting `UPDATE` and `DELETE` on `policy_ruleset` and `policy_rule`, and permitting `UPDATE` on `policy_decision` only for `consumed_at` and `invalidated_reason` transitioning from null (R-01, data-model invariants) (025566c; terminal-state CHECK constraint 1191049; freeze-by-exclusion rewrite 550f376)
- [x] T004 [P] Cross-spec: the `budget_degradation` member on 001's `evidence.type` enum, added **in 001** and only referenced here — this feature does not extend another spec's closed set (R-12) — _already present from 001 (commit 90cbd0d3), confirmed, no action needed_

---

## Phase 2: Foundational (blocks US1–US5)

**Purpose**: the three artifacts that make determinism a property of the data rather than a claim
about the implementation — the closed input record, the lattice and the pure evaluator.

- [x] T005 **Test first**: update a published `policy_ruleset` and `policy_rule` row through Prisma and through raw SQL; both rejected at the database, not by the repository (R-01, quickstart 33) (1123386)
- [x] T006 `domain/decision-input.ts`: the closed `DecisionInput` record as a schema with `additionalProperties: false`, carrying exactly the field groups of [contracts/evaluation.md](contracts/evaluation.md) — action, target (including `targetRef` and `fingerprint`), issue, eligibility (`codeProblemVerdict`, `fixEligible`), evidence, reproduction, impact (including the `ImpactClosure`), reversibility, autonomy, budget, cooldown, escalation, evaluation instant (FR-003, R-03, C-08, C-11) (63f68db; `ImpactClosure` is a local placeholder pending 004)
- [x] T007 **Test first**: a `DecisionInput` carrying `confidence: 0.99` returns `422 VALIDATION` over HTTP and does not compile in-process — **the key does not exist**, it is not validated away (FR-003, SC-002, quickstart 3) (63f68db in-process; HTTP 422 proven in b63eca7/apps/api/policy.e2e.test.ts)
- [x] T008 `domain/outcome-lattice.ts`: the order `ALLOW < REQUIRE_APPROVAL < DENY` and a `max` fold **seeded with `DENY`**, so absence of a rule and conflict between rules are one mechanism (FR-005, FR-006, R-04) (64a3bca)
- [x] T009 **Test first**: property test over the lattice — the fold of any permutation of a matched-outcome multiset is identical, and the empty multiset yields `DENY` with reason `NO_MATCHING_RULE` (FR-002, FR-005, quickstart 4, 5) (64a3bca)
- [x] T010 `domain/predicates/`: the closed predicate vocabulary as `(field, operator, value)` triples over `DecisionInput`, exactly the operator-domain table of [contracts/evaluation.md](contracts/evaluation.md) — **this feature owns the vocabulary**, including the antitone closure forms `containsNoneOf`, `subsetOf`, `sizeAtMost`, `maxDepthAtMost` over 004's `ImpactClosure`, and **no hierarchy operator**: `descendantOf` would read the graph inside the fold (FR-002, R-02, C-16, C-19) (f0d0092; hardened to throw on unrecognised operators b69a9a3; runtime publish-time validator added db8b452/550f376)
- [x] T011 `domain/ceiling.ts`: `ACTION_CEILING` as a pure function `(actionClass, hasTestedUndo) → level | none` — no level at all for `merge`, `forward_deploy` and `irreversible`, and none for `reversible_remediation` while the undo is unattested (FR-008, R-05, C-18) (e07db7f)
- [x] T012 `domain/evaluate.ts`: **pure** `(ruleset, input) → { decision, trace }` implementing the six ordered steps of [contracts/evaluation.md](contracts/evaluation.md) — there is no autonomy step; a rule states the level it requires with `autonomy.level atLeast N`. No clock, no repository, no network and no model in scope, and no `dryRun` parameter (FR-002, FR-019, R-08, C-17) (f5d5cb5; CRITICAL ceiling-clamp-bypass-on-level-0 fixed and re-reviewed b69a9a3)
- [x] T013 **Test first**: property test — evaluate one input 1 000 times and across a generated input corpus; one distinct outcome and one distinct matched-rule set per input, and steps 3–6 never turn a `DENY` into an `ALLOW` (FR-002, SC-002, quickstart 1) (f5d5cb5)
- [x] T014 `policy_action` registry: every action key with its class, `mutating`, owning spec; the typed in-process surface of [contracts/evaluation.md](contracts/evaluation.md) is the only way to obtain an `ALLOW` (FR-001, R-14) (0b45635; `policy.publish_ruleset` added `mutating:false` 03ef2d4)
- [x] T015 [P] Tenant scoping on every repository method; a query built without `TenantContext` fails to type-check (FR-018, 012 T010) (established across 90169ef and every later repository)
- [x] T016 [P] Outbox publishers for the events in [contracts/evaluation.md](contracts/evaluation.md) (FR-017, 012 T012) (a65b8f5)
- [x] T017 [P] `audit_entry` written in the same transaction as the decision, publish, grant, revoke or budget change it describes (FR-017, FR-020, 001 T005) (90169ef; wired into `PublishRuleset` a53a2b9 — plain `policy_decision` rows are the audit-grade record themselves, per QUESTIONS.md "002 — final whole-branch review")

**Checkpoint**: the evaluator exists and is pure. No story can start before this.

---

## Phase 3: US1 — The model proposes, policy decides (P1)

**Independent test**: quickstart 1, 2, 4, 5, 6, 30, 31, 32, 33, 34, 35, 36, 37, 38

- [x] T018 **Test first**: publish the same rules in reverse order, evaluate the whole input corpus against both versions → identical outcomes and identical matched-rule sets (FR-002, R-04, quickstart 5) (7f18b4c)
- [x] T019 `PublishRuleset`: immutable, content-addressed over the ordered rule bodies; identical content is a no-op, changed content is a new version; publish computes `conflict_warnings` for rule pairs that can both match with different outcomes (FR-004, FR-006, R-01) (7f18b4c; digest canonicalization + concurrent-publish race fixed a53a2b9/d9122c3; runtime predicate validation moved here db8b452/550f376)
- [x] T020 **Test first**: one rule allows, another denies, both match → `DENY`, and the pair appears in `conflictWarnings` as a configuration warning (FR-006, quickstart 6) (7f18b4c)
- [x] T021 `EvaluateAndBind`: persists the decision bound to `(workflowRunId, workflowState, proposalDigest, rulesetVersion, autonomyEpoch)` and publishes `PolicyDecisionRecorded` (FR-001, FR-017) (51f3413; `autonomyEpoch` resolved but not persisted — QUESTIONS.md "002 — final whole-branch review"; `actionClass` now resolved from the registry, not caller-supplied — db8b452)
- [x] T022 **Test first**: execute twice against one decision → `DECISION_ALREADY_CONSUMED`; alter the proposal after evaluation then execute → `DIGEST_MISMATCH` (quickstart 35, 36) (51f3413)
- [x] T023 Single-use consumption and digest binding implementing T022; the executor presents the decision identifier and the digest of what it is about to do (FR-001, contracts/evaluation.md) (51f3413; now also refuses a non-`allow`/invalidated decision — db8b452)
- [x] T024 `ExplainDecision` as a **query handler that constructs no repository write**, needing no proposal to exist and reachable with a read-only credential (FR-019, R-08) (4bfb307)
- [x] T025 **Test first**: run the full dry-run matrix and diff the database → zero rows written anywhere; and dry-run and enforcing traces for identical inputs are identical in outcome, matched rules and reason codes (FR-019, quickstart 30, 31) (4bfb307)
- [x] T026 [P] **Test**: search for a code path by which `ExplainDecision` could write → none exists; the guarantee is structural, not a flag (R-08, quickstart 32) (4bfb307; a read-only repository interface split, type-level proof)
- [x] T027 [P] `GET /policy/rulesets`, `POST /policy/rulesets`, `GET /policy/rulesets/{version}` — a version cited by a decision resolves forever (FR-004, SC-003, quickstart 33) (b63eca7)
- [x] T028 [P] `GET /policy/decisions`, `GET /policy/decisions/{decisionId}`, `POST /policy/decisions/{decisionId}/replay` (FR-002, FR-017, quickstart 34) (b63eca7; replay's JSONB-roundtrip crash on instant predicates fixed db8b452)
- [x] T029 [P] `POST /policy/dry-run` and `GET /policy/actions` (FR-019, R-14) (b63eca7)
- [x] T030 [P] `check:decision-replay` — sampled stored decisions replay identically against their own recorded inputs and rule set version (FR-002, SC-002) (c15c47c; now calls the shared `replayDecision` instead of a second implementation, compares `(outcome, matchedRuleKeys)` — db8b452)
- [x] T031 `check:policy-coverage` — executed mutating actions from `audit_entry` left-joined to `policy_decision` on `(tenant_id, action, target_id)`; the join has a key because `audit_entry.action` **is** a registered `policy_action.action_key` and `policy_action.mutating` supplies the filter (001 FR-012, R-14). A row with no consumed `ALLOW` raises an alarm in production, not a test failure at release time (SC-001, 001 T005) (a3e0193; CRITICAL INNER-join-hides-unregistered-actions fixed and join key switched to `policy_decision_id` FK 69146ea, hardened with tenant/action clauses db8b452, mutation-tested 550f376)
- [x] T032 [P] e2e isolation matrix: rule set, grant, decision, approval and budget reads all return **404 for another tenant, never 403** (FR-018, SC-008, quickstart 38) — _scoped to rule set + decision this run (grant/approval/budget endpoints are Phase 4/6/7, not built yet); extend, don't rewrite, when those land — QUESTIONS.md "002 T032/T033"_ (afad064)
- [x] T033 [P] **Test**: publish a rule set, change a budget, grant and revoke → four audit entries naming the actor and the before and after versions (FR-020, quickstart 37) — _scoped to the publish-ruleset audit entry this run (budget/grant/revoke commands are Phase 4/6, not built yet); extend, don't rewrite, when those land — QUESTIONS.md "002 T032/T033"_ (506970b)

**Checkpoint**: the surface 008 and 010 must call before they may write anything exists and is audited.

---

## Phase 4: US2 — Autonomy is granted in increments the customer controls (P1)

**Independent test**: quickstart 7, 8, 9, 10, 11, 12, 13, 14, 15, 39

- [ ] T034 **Test first**: grant L3 for `change.open_pull_request`, whose class `code_change` has ceiling L2 → `422 CEILING_EXCEEDED` (FR-008, SC-004, quickstart 7)
- [ ] T035 `autonomy_grant` check constraint `level <= ACTION_CEILING(action_class, has_tested_undo)` implementing T034 — the row does not exist (R-05, C-18)
- [ ] T036 **Test first**: insert an over-ceiling grant **directly into the table, bypassing the API**; evaluation still refuses and records `ceilingApplied = true` (R-05, quickstart 9)
- [ ] T037 Ceiling clamp `min(grantLevel, ACTION_CEILING(actionClass, hasTestedUndo))` as step 4 of evaluation, implementing T036 — a hand-written row is both refused and ineffective, and neither mechanism is sufficient alone (FR-008, SC-004, C-18)
- [ ] T038 [P] `make gate-ceiling` and `check:ceiling`: no `autonomy_grant` exists above the ceiling for its class, and none of class `reversible_remediation` exists for an action whose undo is unattested; registered in 012's [make-targets contract](../012-engineering-foundation/contracts/make-targets.md) (SC-004, quickstart 9, 39)
- [ ] T039 `GrantAutonomy`, `RevokeAutonomy` and grant resolution over the scope `(tenant, component, environment, issue kind, action)`; grants are additive and a narrower grant never widens a broader one (FR-007, data-model)
- [ ] T040 **Test first**: grant for component A, propose the same action for component B → refused, with the reason naming the missing grant (FR-007, quickstart 11)
- [ ] T041 **Test first**: revoke mid-workflow, let the run reach its next guarded step → `DENY`, with no push mechanism involved (FR-007, R-07, quickstart 12)
- [ ] T042 Evaluation inside the job that performs the action, immediately before it; **no decision is carried across a wait**, which is what makes T041 hold (R-07, contracts/evaluation.md)
- [ ] T043 `autonomy_epoch` incremented in the same transaction as every revocation; `approval_request` records the epoch at issue and it is re-checked at redemption (FR-007, R-07)
- [ ] T044 **Test first**: approve, revoke, then redeem → `STALE_AUTONOMY_EPOCH` and the action does not execute; repeat with the sweep worker disabled and the refusal still holds (R-07, quickstart 13, 15)
- [ ] T045 Revocation sweep: resolve open approval requests in scope to `revoked` and deliver the `approval` callback, so a parked run moves to `needs_human` immediately rather than at its expiry (R-07, quickstart 14, 012 T014)
- [ ] T046 [P] `GET /autonomy/grants`, `POST /autonomy/grants`, `DELETE /autonomy/grants/{grantId}` (FR-007)
- [ ] T047 [P] **Test**: no action of class `merge` or `forward_deploy` exists in the registry, and the ceiling has no level for either — there is nothing to grant (FR-008, quickstart 8)

---

## Phase 5: US3 — Reversible actions are governed separately (P1)

**Independent test**: quickstart 10, 20, 21, 22, 23, 29

- [ ] T048 `reversible` and `hasTestedUndo` predicates **derived from 010's catalogue**, true only when the entry declares precondition, action, verification and undo *and* the undo passed an automated test in the current release; no reversibility column exists in this schema (FR-009, R-06)
- [ ] T049 **Test first**: propose `deployment.rollback` at L5 with a tested undo → permitted, because its class is `reversible_remediation` and rollback is not a forward deploy (FR-008, FR-009, quickstart 10)
- [ ] T050 **Test first**: a catalogue entry with no declared undo is not treated as reversible, and `make gate-undo` fails naming the action — reversibility is demonstrable, never asserted (FR-009, SC-005, quickstart 20, 21)
- [ ] T051 `RemediationCataloguePublished` consumer re-deriving reversibility and tested-undo facts for the action registry, so a removed undo cannot leave a stale permission behind (R-06, contracts/evaluation.md)
- [ ] T052 Verification window on every executed reversible action: failure to observe the expected improvement inside it triggers the undo automatically and reopens the issue (FR-010, quickstart 22)
- [ ] T053 **Test first**: make the undo itself fail → both failures recorded, immediate escalation, and no further automated attempts (FR-010, spec edge case, quickstart 23)
- [ ] T054 Rate limit, cooldown and attempt-cap predicates over `policy_decision` history — the count of consumed `ALLOW` decisions for `(action_key, target_ref, fingerprint)` inside the window, against the bounds in `action_limit`, read in the same query as the rule set, so a refusal is explicable a year later. **This is the only enforcement point**; 010 stores no limits (FR-014, R-13, C-11)
- [ ] T055 **Test first**: propose the same action against the same target and fingerprint repeatedly → refused after the limit with `RATE_LIMITED`, `COOLDOWN` or `ATTEMPT_CAP_REACHED`, and **the refusal is itself a recorded decision**; a different target is unaffected (FR-014, quickstart 29)

---

## Phase 6: US4 — Cost is bounded and degradation is declared (P1)

**Independent test**: quickstart 24, 25, 26, 27, 28

- [ ] T056 Budget aggregation over `agent_run.cost` and `workflow_run` elapsed time by tenant, scope and period key; **no counter is stored here**, so the number policy enforces and the number support reports cannot disagree (FR-011, R-10)
- [ ] T057 [P] `budget_limit`: per-issue limits and the per-tenant period limits inherited from 012's `tenant_budget`; soft thresholds and the escalation attempt cap as configuration (FR-011)
- [ ] T058 **Test first**: drive one issue past its budget → the next AI step is refused and the issue is marked budget-limited with what was completed; the workflow suspends resumably rather than failing (FR-011, quickstart 24)
- [ ] T059 **Test first**: request a step whose `declaredMaxCost` would cross the limit → refused **before** it runs; consumption never exceeds the limit (SC-006, R-11, quickstart 25)
- [ ] T060 Ex-ante budget predicate `consumed + declaredMax ≤ limit` implementing T059, with actual cost landing in `agent_run` and read by the next evaluation (R-11)
- [ ] T061 **Test first**: start a workflow at 23:55 and run past 00:00 → charges stay in the period key pinned at request time; no fresh budget is gained by straddling midnight (spec edge case, quickstart 27)
- [ ] T062 Period key pinned at request time implementing T061; the evaluator reads no clock, so the instant is an input (FR-011, plan constraints)
- [ ] T063 `degradation_step` derived as the count of soft thresholds crossed by `consumed / limit`, monotone within the period because consumption is (FR-012, R-12)
- [ ] T064 `MarkDegradation`: each *first* advance to a step writes exactly one `budget_degradation` evidence record naming the step, the entry applied from the declared `degradation_order`, the consumed and limit figures and the period key; `budget_degradation_mark` on `(tenant, scope, period_key, step)` is the idempotency key against at-least-once delivery (FR-012, R-12, 001 T005, T006)
- [ ] T065 **Test first**: cross the soft threshold under a 400-issue flood → the declared order applies **in order**, one evidence record per step, and tenant spend stays inside the period budget (FR-012, SC-006, quickstart 26)
- [ ] T066 Escalation attempt cap: `escalation.attemptCount` reaches the evaluator as an input read from 012's `workflow_run`, compared against `budget_limit.escalation_attempt_cap`; on reaching it escalation stops and the accumulated evidence, attempted hypotheses and reasons for rejection go to a human (FR-013, quickstart 28)
- [ ] T067 [P] `GET /budgets`, `PUT /budgets`, `GET /budgets/state` (FR-011, FR-020)
- [ ] T068 [P] `BudgetDegraded` carrying the `evidenceId` rather than the degradation text, and `BudgetExhausted` (FR-012, contracts/evaluation.md)
- [ ] T069 [P] `check:budget-reconcile` — derived consumption matches `agent_run` and `workflow_run` (R-10)

---

## Phase 7: US5 — Approvals are reviewable, not rubber stamps (P2)

**Independent test**: quickstart 16, 17, 18, 19

- [ ] T070 `RequestApproval`: the summary carries the proposed action, reason codes, evidence identifiers, impact summary and rollback plan, and the run parks on 012's `approval` callback (FR-015, quickstart 17, 012 T014)
- [ ] T071 **Test first**: inject instruction-shaped text into the issue's evidence, then open the request → the summary carries identifiers and structured fields only; no collected customer text reaches the one human whose click authorises a mutation (data-model, quickstart 18, 003 FR-021)
- [ ] T072 **Test first**: let a request lapse → state `expired`, a `policy_decision` with outcome `DENY` and reason `APPROVAL_EXPIRED`, the run to `needs_human`; and no second approver is consulted (FR-016, SC-007, quickstart 16, 19)
- [ ] T073 `ExpireApproval` on the `workflow_run.deadline_at` tick implementing T072, with `expires_at` projected onto the run's deadline so an expiry always has a tick that will fire it (R-09, 012 T013)
- [ ] T074 `ResolveApproval` recording which human decided and against which rule set version (FR-017, quickstart 17)
- [ ] T075 [P] `GET /approvals`, `GET /approvals/{approvalId}`, `POST /approvals/{approvalId}/resolve` (FR-015, FR-017)
- [ ] T076 [P] `check:stale-approvals` — no pending request past `expires_at` without a fired deadline

---

## Phase 8: Polish and cross-cutting

- [ ] T077 [P] `IssueStateChanged` consumer invalidating outstanding decisions bound to a run in a terminal state (contracts/evaluation.md)
- [ ] T078 [P] Coverage floor 95% for `packages/domain/policy/**`, enforced by `test-unit` (012 FR-012)
- [ ] T079 [P] Regenerate `contracts/openapi.json` and check for drift with `contracts-check` (012 FR-010)
- [ ] T080 [P] Performance check against the plan budget: evaluation under 20 ms p95 excluding the budget aggregate, the aggregate under 50 ms p95 at 10 000 agent runs per tenant-month; record the numbers
- [ ] T081 Run the whole of [quickstart.md](quickstart.md) — all 41 scenarios, including the twelve that must be refused

---

## Phase 9: Analyze-pass additions

Added after `/speckit-analyze`. Numbered from the end so the identifiers other specs already cite
stay stable; each one belongs to the phase named in its line.

- [ ] T082 [Phase 2] `eligibility.codeProblemVerdict` and `eligibility.fixEligible` as `DecisionInput` fields read from 006's classification and its `fix_eligibility` view, with a test that a proposal of class `code_change` is refused when the verdict is not `code_problem` — the same gate 008 guards at loop entry, read from both sides (C-08, FR-003, 006 FR-002)
- [ ] T083 [Phase 4] Grant-time attestation check: `POST /autonomy/grants` for an action of class `reversible_remediation` whose catalogue undo has no passing test returns `422 UNDO_NOT_ATTESTED`, and the clamp refuses it independently when the row is written by hand (C-18, FR-009, quickstart 39)
- [ ] T084 [P] [Phase 5] Contract test: every action key in 010's [action catalogue](../010-safe-remediation/contracts/action-catalogue.md) exists in `policy_action` with `action_class = reversible_remediation`, and no catalogue key is spelled differently in the two specs (data-model, 010 FR-001)
- [ ] T085 [Phase 5] `action_limit` bounds per `(tenant, action_key)` — rate per window, cooldown, attempt cap — as the single store for FR-014, with a test that removing 010's own limit store changes no refusal (C-11, R-13)
- [ ] T086 [Phase 2] **Test first**: three fixture branches raising a ceiling level — one citing nothing, one citing an unresolvable derivation, one citing an artifact whose digest disagrees with its row — each fails `gate-ceiling`; a fourth branch citing a resolvable derivation passes. The test asserts on the **diff**, because the ceiling is a literal in code and no data check sees an edit to it (FR-008a, SC-009, R-15, 012 `gate-ceiling`)
- [ ] T087 [Phase 2] `ACTION_CEILING` keeps its level table as named constants a diff can be read against, each raise-eligible entry carrying the derivation citation in a form 012's gate resolves — and **no configuration input of any kind**, so the evaluation path gains no branch and the ceiling's strength stays "a literal in code" (FR-008a, R-15, R-05, C-18)
- [ ] T088 [Phase 6] Product bounds on the escalation attempt cap and on the per-issue and per-tenant budgets: a literal maximum in the migration, the same value as a constant in code, and a **test first** asserting a configuration write above either bound is refused and that the two values agree. Every other unset value in this feature ships a starting value chosen to fail closed — tight budgets, low caps (FR-021, [stage 0 S0-7](../../docs/stage-0.md))

---

## Dependencies

```text
012 phases 1–2 ──┐
001 phase 2 ─────┴──▶ Phase 1 (T001–T004) ──▶ Phase 2 (T005–T017)
                                                  ├─▶ Phase 3 · US1 (T018–T033)
                                                  ├─▶ Phase 4 · US2 (T034–T047)
                                                  ├─▶ Phase 5 · US3 (T048–T055) ← needs 010's catalogue
                                                  ├─▶ Phase 6 · US4 (T056–T069) ← needs T004
                                                  └─▶ Phase 7 · US5 (T070–T076) ← needs T021
Phase 8 (T077–T081) last
Phase 9 (T082–T085) lands with the phase each line names, not after Phase 8
```

**Explicit dependencies beyond phase order**

- T012, the pure evaluator, is the single dependency of every story phase. Nothing in phases 3–7 can
  start before it, and nothing in it may acquire a repository, a clock or a logger later.
- T035 and T037 are one requirement in two mechanisms. They land in the same phase, and T036 is the
  test that proves the second still holds when the first is bypassed — write T036 before T037.
- T045 needs 012's callback registry (012 T014); T042 and T073 need the workflow machine and its
  deadline tick (012 T013).
- T048, T050 and T051 need 010's reversible-action catalogue. Write the predicate and the gate first
  and enable them in `ci` when the catalogue lands — the same approach 012 takes with `gate-undo`.
- T064 needs the `budget_degradation` enum member (T004) and 001's evidence repository
  (001 T005, T006); the evidence record is the deliverable, the mark table only its idempotency key.
- T056 and T069 need 012's `agent_run` cost accounting to be measured rather than estimated.
- T031 reads 001's audit trail and stays advisory until the first mutating feature (008, 010)
  executes through the evaluation surface; it is the check that catches the bypass a review missed.
- T052 and T066 are consumed by 010 and 006 respectively, but both are policy-side and can land
  before those features exist.

## Parallel groups

- Setup: T002, T003, T004 together.
- Foundational: T015, T016, T017 after T012 — different files, no ordering between them.
- US1 read and check surfaces: T026–T030, T032, T033 together after T024.
- US2: T038, T046, T047 after T037.
- US4: T057, T067, T068, T069 alongside T063–T066.
- Polish: T077–T080.

## Strategy

1. **Phase 2 before every story, and T006 · T008 · T012 before anything else in it.** The closed
   input record, the `DENY`-seeded lattice and the pure evaluator are what make FR-002 and FR-003
   properties of the shape of the data. Written after the first caller, each becomes a refactor of
   every caller — and a confidence field that was once accepted is a field somebody is already
   passing.
2. **US1 next, because it is the gate every writing feature must pass.** 008 and 010 cannot be built
   safely before the surface they are required to call exists, and FR-001 forbids a bypass path from
   ever existing rather than asking us to remove one later.
3. **US2 with US1.** The ceiling is the one property a tenant cannot be allowed to discover by
   experiment, and it is enforced twice on purpose: the constraint stops the row, the clamp stops the
   row that was written anyway. Landing only one of them is the silent failure R-05 exists to prevent.
4. **US3 after US2**, because reversibility is derived from 010 and the derivation is only meaningful
   once the ceiling distinguishes `reversible_remediation` from `code_change`. The `gate-undo` hook
   goes in early even while the catalogue is thin — a gate added after the violations exist starts
   life red and gets disabled.
5. **US4 alongside US3.** Budgets are the other unbounded path in this product, and the ex-ante
   charge (T059, T060) has to be in place before any flood test is meaningful: a check on consumption
   alone always permits exactly one step more than the budget allows.
6. **US5 last of the stories.** An approval is the only decision that legitimately spans a wait, so
   it depends on the epoch (T043) and the binding (T021) already being right. Building it first would
   mean building the one place revocation cannot be handled by re-evaluation before the mechanism
   that handles it everywhere else.
7. Phase 8 before the pilot. The replay, coverage and reconciliation checks are continuous, not
   release-time: this is the component where being wrong permits an action.
