# Contract: the fix loop state machine

A workflow definition executed by 012's engine (012 FR-029), persisted in `workflow_run` with its
own append-only `change.fix_loop_transition` record. **This document is what a reviewer checks
Principle II against**, so it states not only the order but what each guard is allowed to read.

## States

```text
LOOP_ENTRY ──both eligibility views true──▶ ANCHOR_PENDING
  └─▶ ANCHORED ──▶ REPRODUCED ──▶ IMPACT_ANALYSED ──▶ PLAN_SUBMITTED ──▶ PLAN_APPROVED
        │                                                      │
        │                                                      ▼
        │                                          AWAITING_REPO_LEASE ──▶ TEST_WRITTEN
        │                                                                      │
        ▼                                                                      ▼
   NOT_ELIGIBLE ──▶ human handoff                                        RED_VERIFIED
                                                                               │
                                                                               ▼
                                                                      PATCH_APPLIED
                                                                               │
                                                                               ▼
                                                                       GREEN_VERIFIED
                                                                               │
                                                                               ▼
                                                                        SUITE_PASSED
                                                                               │
                                                                               ▼
                                                                    awaiting_ci ──▶ E2E_RETURNED
                                                                                        │
                                                                                        ▼
                                                                                  VERIFIED
                                                                                        │
                                                                                        ▼
                                                                                  PR_OPENED
```

Terminal off-ramps from any state: `REJECTED` (verdict), `STALE` (base moved, R-17),
`BUDGET_EXHAUSTED` (002 FR-011), `HUMAN_HANDOFF` (002 FR-013), `NO_RECIPE` (the only reproducing rung
needed an anonymised extract and the synthetic equivalent did not reproduce — C-23, FR-011a).

`VERIFIED` is reachable only through `E2E_RETURNED`, or through a `component_verification_policy` row
for that component whose `e2e_required` is false — a tenant declaration, defaulting to true (R-27).
Until then the presented state is `awaiting_ci` and the pull request says so (FR-020).

## Transition guards

Each guard is a deterministic predicate. A guard that cannot determine its answer fails
(012 R-10 — gates fail closed).

| Transition | Guard requires | Reads |
|---|---|---|
| → `ANCHOR_PENDING` (loop entry) | **both** `diagnosis.fix_eligibility.eligible` (006) **and** `reproduction.change_eligibility.eligible` (007) are true, read from the views by this guard itself — not taken from `DiagnosisCompleted` or `ReproductionCompleted`, which are triggers (C-08, 006 FR-002, 007 FR-001) | 006 and 007 views |
| → `ANCHORED` | `anchor_resolution.verdict = ANCHORED`; `anchor_grant_id` non-null and the grant not revoked; `adopted_by_actor_type = human`; `adopted_at < issue.first_seen_at` — all four from the resolution's own immutable copies (C-12) | 005's `anchor_grant` only. **Not** 006's claim that an expectation exists (R-04), and **not** an `ExpectedBehavior.state` column (C-12) |
| → `NOT_ELIGIBLE` | any other anchor verdict, including 006 `NO_EXPECTATION` (006 FR-011), or either eligibility view false | 005, 006, 007 views |
| → `REPRODUCED` | `change_eligibility.eligible` is true — a recorded 007 attempt whose latest result is `FAIL` — and the attempt's `reproducing_rung`, `observed_runs`, `reproduced_runs` and fixture `recipe` availability are copied onto the attempt for the GREEN guard and the `NO_RECIPE` off-ramp (FR-009, 007 FR-001, C-08, C-23) | 007 attempt record and view |
| → `IMPACT_ANALYSED` | a `change_graph` exists for the current base commit; every edge carries a `derivation`; coverage gaps recorded | deterministic graph; annotations are not read by this guard |
| → `PLAN_SUBMITTED` | plan names primary, dependent and test files, reason, classification, blast radius, anchor reference (FR-004); **no declared path resolves to an expectation-defining document** — that is a hard refusal, not a masking candidate to weigh (FR-014a) | plan, 005's document sources |
| → `PLAN_APPROVED` | `PolicyDecision.outcome ∈ {ALLOW, REQUIRE_APPROVAL→granted}` for the **current** plan version (002 FR-001) | 002 |
| → `TEST_WRITTEN` | test file inside `change_plan_file` with `role = test`; assertion references the anchored expectation version's constraint. Where the reproducing rung's fixture was `anonymised` and therefore has no recipe (007 R-06), the test carries a **synthetic equivalent** built to the failing constraint; if it does not reproduce, the loop takes the `NO_RECIPE` off-ramp to a human (FR-011a, C-23) | 005 constraint, plan, 007 fixture metadata |
| → `RED_VERIFIED` | an execution on the **base commit** where the regression test fails **and** the normalised failure signature matches the issue's fingerprint under the issue's ruleset version (FR-010, 007 FR-005) | 007 execution record, 001 fingerprint |
| → `PATCH_APPLIED` | every hunk path ∈ `change_plan_file` for the plan version in force **and** no hunk path resolves to an expectation-defining document (FR-014a); applier holds the credential, agent does not (FR-025) | plan, 005's document sources |
| → `GREEN_VERIFIED` | a `RED_VERIFIED` transition exists for the same `regression_test_id` whose execution commit is the parent of the patch; the regression test passes on the patched commit; where the reproduction was intermittent, it stops reproducing across **007's `observed_runs` for the reproducing rung** — that number, not 008's own `repeat_count`, which governs flakiness quarantine (FR-011, 007 FR-007, 007 R-18) | 007 execution records and attempt record |
| → `SUITE_PASSED` | no test that passed in `test_baseline` fails now; quarantined tests excluded from both sides (FR-012, FR-013) | baseline, executions |
| → `E2E_RETURNED` | a CI callback for this attempt arrived and its results are recorded as evidence (007 FR-022, FR-023, 012 FR-030) | callback |
| → `VERIFIED` | `verification_verdict.verdict = APPROVE` with `independence_rank_achieved ≥ 3` and ≥ 1 pre-chain anchor used (FR-018); and either `E2E_RETURNED`, or `component_verification_policy.e2e_required = false` for the component (R-27, FR-020) | verdict, component policy |
| → `PR_OPENED` | every mandated section populated (FR-021); idempotency key and pre-flight search clear (R-18) | PR record |

**No guard reads a model-reported confidence value** (FR-019, 002 FR-003). Confidence is stored on
`verification_verdict` for observability and is not a column any predicate joins on.

## Why skipping is unsatisfiable rather than merely refused

`RED_VERIFIED` and `GREEN_VERIFIED` are guarded by 007 execution records, which carry an immutable
execution identifier and the commit they ran against (007 FR-013). The change agent has no tool that
writes an execution record and no credential that reaches the sandbox directly (007 FR-028). So
`GREEN` without `RED` is not a rule the loop is asked to respect — it is a row that does not exist.

`fix_loop_transition` is append-only with unique `(attempt_id, seq)` and `(attempt_id, to_state)`,
so a state cannot be entered twice, re-entered after a rollback, or quietly rewritten.

## Verifier input projection

The verifier is invoked with a typed projection. Its input type contains exactly:

```text
anchorResolution        verdict, expectation text, constraint kinds, adoption record
executions              red, green, suite, e2e — identifiers, commits, signatures, outcomes
baselineDiff            newly failing tests
changeGraph             deterministic nodes and edges, classification, touch predicates
coverageGaps            unsupported languages, untested surfaces in the blast radius
maskingFindings         pattern, location, disposition
patch                   the diff
evidence                raw Evidence records for the issue (001)
```

It does **not** contain the change agent's hypothesis prose, rationale, tool transcript or
confidence (R-12, FR-016). The projection is a function with a declared return type; adding a field
that carries the change agent's reasoning is a type change in a reviewed file, not a prompt edit.

**`changeGraph`, `coverageGaps`, `maskingFindings` and `patch` were produced earlier in this same
chain.** They may inform a **rejection** — a coverage gap or a masking finding is a reason to refuse —
but they can never raise `independence_rank_achieved`, and they are never counted among the pre-chain
anchors `APPROVE` requires (FR-018, R-13, ADR 0002). Only `anchorResolution`, `executions` and
`evidence` do that.

## Verdict routing

| Verdict | Effect |
|---|---|
| `APPROVE` | → `PR_OPENED` |
| `REJECT_PATCH` | attempt closed and preserved; new attempt within the cap, same anchor and plan |
| `REJECT_DIAGNOSIS` | plan `invalidated`; routes to 006 for its **one** re-diagnosis (006 FR-024, D-08); a second such verdict hands off to a human with every attempt (FR-028) |
| `INSUFFICIENT_EVIDENCE` | returned automatically when the only anchor available is an artifact from earlier in the same chain (FR-018); routes to human handoff carrying what was ruled out |

## Never waiting

`AWAITING_REPO_LEASE` and `awaiting_ci` are persisted states with a `deadline_at` and a
`workflow_callback`, never a blocked job (012 FR-025..027, FR-030, ADR 0003). `awaiting_ci` keeps its
lower-case spelling because it is also the **presented** label carried on
`pull_request_record.awaiting_ci` (FR-020, R-24); every purely internal state is upper-case. A callback that never
arrives is resolved by the deadline and recorded as such — an attempt does not sit in `awaiting_ci`
indefinitely looking like progress.

## What this contract does not permit

- No merge transition exists in this machine, at any autonomy level, under any configuration
  (FR-024, D-12).
- No transition is authored by an agent; transitions are effected by the workflow engine on
  deterministic guards.
- No guard reads `change_graph_annotation` to weaken a deterministic edge — annotations are additive
  and may only widen (R-02, C-03).
- No plan and no patch may touch an expectation-defining document. A fix that carried its own anchor
  would pass a reviewer who believes they are approving a bug fix; changing an expectation is a
  separate merge request with 005's human adoption behind it (FR-014a, FR-008, D-20).
- No guard reads an eligibility **event**. The loop entry reads 006's and 007's views itself (C-08).
