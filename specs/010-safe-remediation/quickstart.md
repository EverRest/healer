# Quickstart: reversible production actions

```bash
make bootstrap
make test -- --testPathPattern domain/remediation
make test-e2e -- --testPathPattern 010-
make gate-undo                      # enumerates the catalogue; fails if any undo is untested
```

`gate-undo` (012 FR-014) is the admission gate. An action without a passing undo test in the current
build does not load, so a developer who adds an action and skips the test finds out before review,
not in production.

## Scenarios

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 1 | Deploy-correlated rollback | replay a post-deploy error-rate regression in staging | rollback proposed, policy decision recorded, executed by the runner, verified against a baseline taken before the deploy (US1) |
| 2 | Verification fails | force the error rate to stay elevated | undo runs automatically, issue reopened (FR-006, SC-003) |
| 3 | Signal unavailable | break the metric source during the window | window closes `inconclusive`, undo runs, escalation raised — not "assume it worked" |
| 4 | Verification is not self-report | inspect what closes the window `improved` | a `metric_delta` evidence record from the verification step; the action's own result is not an anchor (R-03) |
| 5 | Anchor must pre-date the issue | define an action whose baseline window overlaps the incident | rejected at catalogue load (R-03) |
| 6 | Four declarations | remove an undo from an action definition | catalogue load rejects it; the action cannot be proposed (FR-002, SC-001) |
| 7 | Untested undo | add an action with an undo but no test | `gate-undo` fails naming the action (012 FR-014) |
| 8 | Stale attestation | keep the test, change the action's code | attestation digest no longer matches the build; the action does not load (R-02) |
| 9 | **Forward deploy is not expressible** | try to roll back to a version not in the target's history | rejected by the parameter schema — there is no field for it (R-04, 002 FR-008) |
| 10 | Nothing to roll back to | target is on its first deployment | precondition fails **at execution**, not only at proposal (FR-004) |
| 11 | Known-bad previous version | mark the prior deployment known-bad | refused, naming the version (FR-022) |
| 12 | Migration in range | prior deployment separated by an irreversible migration | refused; approval with a human plan required (FR-022) |
| 13 | Dry-run mutates nothing | run every catalogue action in dry-run against a live environment | zero state changes in **the environment's own audit log** (SC-005) |
| 14 | Dry-run cannot execute | inspect the dry-run call path | it holds a read-only platform handle; `apply()` is unreachable, not merely unreached (R-10) |
| 15 | Dry-run precondition | dry-run with a failing precondition | reports the failing precondition instead of a plan (FR-007) |
| 16 | No shell path | audit the runner's action surface | every action is a named schema; no generic command endpoint exists (SC-006, FR-009) |
| 17 | Policy first | attempt to dispatch without a decision | impossible — no path exists; reconciliation finds 0 executions without a decision (SC-002) |
| 18 | Missing grant | propose an enabled action on an ungranted component | refused naming the missing grant (002 FR-007) |
| 19 | No rule | remove every matching rule | `DENY` (002 FR-005) — absence never permits |
| 20 | Grant revoked mid-flight | revoke during `awaiting_approval` | the guarded step stops and requires approval (002 FR-007) |
| 21 | Duplicate dispatch | deliver the same `invocationId` twice | exactly one applied effect (SC-007, FR-010) |
| 22 | Concurrent proposals | two proposals against one target at once | second refused `TARGET_BUSY` by the unique index, not by a lock (R-07) |
| 23 | Blast radius | scale request exceeding `maxReplicaDelta` | refused with the limit named — **not** truncated (FR-014) |
| 24 | Eligibility is opt-in | propose against a target with no eligibility entry | refused (FR-015) |
| 25 | Kill-switch flag | flag not marked remediable | refused (FR-015, edge case) |
| 26 | Queue drain is not deletion | inspect the drain parameter schema | move-to-holding with a restore undo; no delete field exists (FR-021) |
| 27 | Restart minimum replicas | restart the last healthy replica | precondition refuses it |
| 28 | **Recurrence escalates** | induce a failure that restart relieves for 20 minutes, three times | third attempt refused; escalation carries three attempts, intervals and per-attempt evidence (SC-011, FR-016) |
| 29 | Recurrence survives new issues | make each recurrence fall outside the reopen window, so each creates a new issue | the cap still fires — counting is per `(target, fingerprint)`, not per issue (R-08) |
| 30 | Cooldown | propose again inside the cooldown | refused until it elapses (002 FR-014) |
| 31 | **Undo failure stops everything** | make the undo fail | both failures recorded as evidence, immediate escalation, `target_block` opened (FR-019, SC-008) |
| 32 | Block covers the target, not the action | propose a *different* action against a blocked target | refused (R-09) |
| 33 | Observed, not intended | make the target unreadable after the undo failure | escalation says the state is unreadable; it does not report the intended state (US7, R-09) |
| 34 | Block cleared by a human only | attempt to clear a block automatically | no path exists; clearing records the human and the note |
| 35 | External change | roll back manually during our verification window | verification invalidated and escalated; the outcome is **not** attributed to the remediation (FR-020, R-13) |
| 36 | Connectivity loss | drop the runner after dispatch | state reconciled from the target on reconnect, never assumed (edge case, 012 FR-021) |
| 37 | Duplicate result event | deliver the result twice | no double-apply (FR-010) |
| 38 | Never wait in a job | inspect the verification path | persisted state plus `verification_tick` callback; `lint` fails on a sleep in a processor (012 FR-025, 012 FR-026) |
| 39 | Mitigation, not resolution | remediate an issue classified as a code problem | recorded as mitigation; the issue is **not** closed (FR-017, R-11) |
| 40 | Justification required | propose with no evidence references | refused `JUSTIFICATION_MISSING` (FR-018) |
| 41 | Missing adapter | runner without the capability for an action | catalogue shows it unavailable; a proposal is refused, never degraded (R-14, 012 FR-018) |
| 42 | Structured results only | inspect what crosses the boundary after an execution | state before, state after, metric deltas, operation identifiers — no raw log bodies (FR-025) |
| 43 | Tenant isolation | read another tenant's attempt, target, block and history; dispatch against their target | 404 on every read; the target is unresolvable for dispatch (SC-009) |
| 44 | Audit completeness | take any attempt | actor, action, target, parameters, policy decision, evidence references and outcome all resolve (FR-023) |
| 45 | The MTTR claim | compute SC-010 over **live L2+ tenant data**, then over a tenant with no merged fixes yet | median `time_to_verified_remediation` at most half the median time to a merged fix for deploy-correlated regressions; `insufficient_observation` with a reason in the second case — never a benchmark figure, since a replay dispatches nothing and merges nothing (SC-010, R-15, D-19a) |

## Invariant checks (run continuously, not only in tests)

```bash
npm run check:remediation-policy      # every executed attempt has a policy decision (SC-002)
npm run check:undo-attestation        # every loadable action attests an undo on this build (R-02)
npm run check:target-serialisation    # at most one live mutation per target (R-07)
npm run check:open-blocks             # no automated attempt after an open block (SC-008)
```
