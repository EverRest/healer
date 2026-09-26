# Quickstart: policy engine, autonomy levels and budgets

```bash
make bootstrap
make test -- --testPathPattern domain/policy
make test-e2e -- --testPathPattern 002-
make gate-undo          # every reversible action has a tested undo (012 FR-014, SC-005)
make gate-ceiling       # no grant and no evaluation exceeds the product ceiling (SC-004)
```

## Scenarios

Scenarios 4, 6, 7, 9, 12, 16, 19, 21, 24, 25, 27 and 39 must **fail** — a guard nobody has seen fire
is a guard nobody knows works.

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 1 | Determinism | evaluate the same input 1 000 times | one distinct outcome and one distinct matched-rule set (FR-002) |
| 2 | Confidence is not an input | two proposals identical but for declared confidence | identical decisions (SC-002) |
| 3 | Confidence is not representable | post a `DecisionInput` carrying `confidence: 0.99` | `422 VALIDATION` — the key does not exist (FR-003, R-03) |
| 4 | No rule, no permission | evaluate an action no rule matches | `DENY` with reason `NO_MATCHING_RULE` (FR-005) |
| 5 | Order independence | publish the same rules in reverse order | identical digest-independent outcomes across every input in the corpus (R-04) |
| 6 | Conflict resolves down | one rule allows, another denies, both match | `DENY`, and the pair appears in `conflictWarnings` (FR-006) |
| 7 | Ceiling: grant refused | grant L3 for `change.open_pull_request` (class `code_change`, ceiling L2) | `422 CEILING_EXCEEDED` (FR-008, SC-004) |
| 8 | Ceiling: no merge action exists | look for an action of class `merge` or `forward_deploy` in the registry | none, and the ceiling has no level for either — there is nothing to grant (008 FR-024) |
| 9 | Ceiling: clamp survives a hand-written row | insert an over-ceiling grant directly into the table, bypassing the API | evaluation still refuses; `ceilingApplied = true` (R-05) |
| 10 | Rollback is not a forward deploy | propose `deployment.rollback` at L5 with a tested undo | permitted — class `reversible_remediation`, not a forward deploy (FR-008, 010 FR-001) |
| 11 | Grant is scoped | grant for component A, propose for component B | refused, reason naming the missing grant (FR-007) |
| 12 | Revocation hits the next step | revoke mid-workflow, let the run reach its next guarded step | `DENY`; no push mechanism was needed (R-07) |
| 13 | Revocation invalidates a granted approval | approve, revoke, then redeem | `STALE_AUTONOMY_EPOCH`; the action does not execute |
| 14 | Revocation moves a parked run | revoke while a run awaits approval | request `revoked`, callback delivered, run → `needs_human` immediately — not at expiry |
| 15 | Revocation without the sweep | disable the sweep worker, revoke, redeem an approval | still refused — correctness does not depend on the background job (R-07) |
| 16 | Approval expiry stops | let a request lapse | `expired`; `DENY(APPROVAL_EXPIRED)` recorded; run → `needs_human` (FR-016, SC-007) |
| 17 | Approval content | open a pending request | action, reason codes, evidence ids, impact summary, rollback plan (FR-015) |
| 18 | Approval carries no customer text | inject instruction-shaped text into the issue's evidence, open the request | the summary carries identifiers and structured fields only |
| 19 | No implicit delegation | expire a request while the approver is away | lapses; no second approver is consulted |
| 20 | Reversible needs four parts | register a catalogue action without an undo | rejected at catalogue load (FR-009, 010 FR-002) |
| 21 | Undo gate | remove the undo test for a catalogue action | `make gate-undo` fails naming the action (SC-005) |
| 22 | Verification window | execute a reversible action, withhold the expected improvement | undo runs automatically, issue reopened (FR-010) |
| 23 | Undo fails | make the undo fail | both failures recorded; escalation; no further automated attempts |
| 24 | Per-issue budget | drive one issue past its budget | next AI step refused; issue marked budget-limited with what completed (FR-011) |
| 25 | Ex-ante charge | request a step whose declared max would cross the limit | refused **before** running it; consumption never exceeds the limit (SC-006, R-11) |
| 26 | Degradation order | cross the soft threshold under a 400-issue flood | declared order applied in order; one evidence record per step; spend inside the period budget (FR-012, SC-006) |
| 27 | No budget at midnight | start a workflow at 23:55 and run past 00:00 | charges stay in the pinned period key; no fresh budget |
| 28 | Escalation cap | fail repeatedly until the cap | escalation stops; evidence and ruled-out hypotheses handed to a human (FR-013) |
| 29 | Cooldown | propose the same action against the same target repeatedly | refused after the limit, and the refusal is a recorded decision (FR-014, R-13) |
| 30 | Dry run writes nothing | run the full dry-run matrix, diff the database | zero rows written anywhere (FR-019) |
| 31 | Dry run is the same path | compare dry-run and enforcing traces for identical inputs | identical outcome, matched rules and reason codes (R-08, 011 FR-003) |
| 32 | Simulator cannot mutate | search for a code path by which `ExplainDecision` could write | none exists — structural, not a flag (011 FR-004, FR-005) |
| 33 | Rule set resolves forever | take a decision from an earlier rule set version, fetch the version | resolves with the exact rules (SC-003) |
| 34 | Replay | replay a stored decision against its own inputs | identical outcome (FR-002) |
| 35 | Decision is single-use | execute twice against one decision | `DECISION_ALREADY_CONSUMED` |
| 36 | Digest binding | alter the proposal after evaluation, then execute | `DIGEST_MISMATCH` |
| 37 | Config change is audited | publish a rule set, change a budget, grant and revoke | four audit entries naming actor, before and after versions (FR-020) |
| 38 | Tenant isolation | read another tenant's rule set, grant, decision, approval and budget | 404 on every one — never 403 (FR-018, SC-008) |
| 39 | Unattested undo has no level | remove the undo test for `deployment.rollback`, then grant it any level and propose it | grant refused with `UNDO_NOT_ATTESTED`; a hand-written grant is clamped to no level and the decision carries `ceilingApplied = true` — `reversible_remediation` earns L5 only with an attested undo (C-18, FR-009) |
| 40 | **Raising the ceiling needs the evidence** | open four branches raising a ceiling level: citing nothing, citing an unresolvable derivation, citing an artifact whose digest disagrees, and citing a resolvable one | the first three fail `gate-ceiling`, the fourth passes; the check reads the **diff**, since nothing about the ceiling is data (FR-008a, SC-009, 011 FR-021c) |
| 41 | Stop rules have bounds | raise the escalation attempt cap and each budget above the product bound | refused at the configuration write; the literal and the constant in code agree (FR-021) |

## Invariant checks (run continuously, not only in tests)

```bash
npm run check:policy-coverage      # every executed mutating action has a consumed ALLOW (SC-001, R-14)
npm run check:decision-replay      # sampled stored decisions replay identically (FR-002)
npm run check:ceiling              # no grant above ACTION_CEILING for its class (SC-004)
npm run check:budget-reconcile     # derived consumption matches agent_run and workflow_run (R-10)
npm run check:stale-approvals      # no pending request past expires_at without a fired deadline
```
