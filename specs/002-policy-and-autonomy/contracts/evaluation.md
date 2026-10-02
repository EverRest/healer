# Contract: policy evaluation

The surface every mutating feature calls. It is a **typed in-process interface**, not an HTTP call
(D-06, ADR 0005): internal callers keep types and transactions, and permission enforcement stays in
one place instead of being re-implemented at a network edge. The only evaluation reachable over HTTP
is the dry run, which writes nothing ([openapi.yaml](openapi.yaml)).

## The two callers, and why there is no flag

```text
evaluate(ruleset, input) → { decision, trace }        pure; no clock, no repository, no network

EvaluateAndBind   (command)  persists the decision, binds it to a workflow run, publishes an event
ExplainDecision   (query)    returns decision + trace, persists nothing, needs no proposal to exist
```

Both call the same `evaluate`. The evaluator takes no `dryRun` parameter because it has nothing to
switch on (R-08). `ExplainDecision` is a query handler that constructs no repository write — which
is what makes 011 FR-004's "structurally incapable of mutating" a fact about the code rather than a
statement about a configuration value.

## `DecisionInput` — the closed record

Schema-validated with `additionalProperties: false`. Unknown keys are rejected, which includes any
attempt to pass model-reported confidence: **the field does not exist** (FR-003, R-03).

| Group | Fields | Supplied by |
|-------|--------|-------------|
| action | `actionKey`, derived `actionClass` | the calling feature; key must be registered |
| target | `componentId`, `environment`, `issueKind`, `targetRef`, `fingerprint` | 001, 004 |
| issue | `state`, `classification` | 001 FR-006, 006 FR-001 |
| eligibility | `codeProblemVerdict` ∈ `code_problem` · `not_a_code_problem` · `undetermined` · `absent`, `fixEligible` | 006 — the classifier verdict and the `fix_eligibility` view (C-08) |
| evidence | `complete`, `conclusionHasLink` | 001 FR-009 |
| reproduction | `outcome` ∈ `pass` · `fail` · `inconclusive` · `absent` | 007 FR-004 |
| impact | `classification`, `touchesPublicContract`, `touchesMigration`, `touchesAuthPath`, `touchesMoneyPath`, `closure` | 008 FR-003, 004 — consumed, never computed here |
| reversibility | `reversible`, `hasTestedUndo` | derived from 010's catalogue (010 FR-002, FR-003) |
| autonomy | resolved grant level for the scope | this feature |
| budget | consumed, limit, `declaredMaxCost`, degradation step | **resolved, not supplied**: aggregated from 012 FR-036 for the issue and run the evaluation is bound to. The caller's `consumed`, `limit` and `degradationStep` are ignored and replaced; only `declaredMaxCost` is the step's own. Dry run and enforcing evaluation resolve the same figures when given the same binding |
| cooldown | `recentAllowCount`, `windowSeconds`, `attemptCount` — counted over `policy_decision` history for `(actionKey, targetRef, fingerprint)` | this feature (R-13, C-11) |
| escalation | `attemptCount`, `escalating?` | `attemptCount` is **resolved from 012's `workflow_run`** — counted from that run's transitions into `escalating`, not stored as a counter here (FR-013); the caller's value is ignored. **Nothing produces that state yet** (006/008/012 own the escalation flow), so the count is 0 today. `escalating` is the calling feature's structural statement that *this proposal is an escalation*; absent means false |
| time | `evaluatedAt` | the caller — the evaluator reads no clock, so a decision replays |

`targetRef`, `fingerprint` and every string field is an identifier or an enumerated value. **No field
carries collected content**: a log line, a commit message or a ticket body has no route into a
predicate, which is the mechanism behind 003 FR-021 and 003 SC-010.

**This feature is the only enforcement point for rate limits, cooldowns and attempt caps** (C-11).
They are predicates over the record above, scoped by `(actionKey, targetRef, fingerprint)`, so every
refusal is a recorded decision with a reason code rather than a counter somewhere else (FR-014,
R-13). 010 holds no limit store of its own and projects only the refusal reason codes.

`codeProblemVerdict` and `fixEligible` are read here **and** guarded at 008's loop entry (C-08): two
indexed reads against the one gate whose failure means a patch on a Redis outage.

### Operator domains

A predicate is `(field, operator, value)`. The operator set permitted for a field follows from its
type, and a rule using an operator outside its field's domain is rejected at publish time — not at
evaluation time, because a ruleset that can fail to evaluate is not deterministic.

**This table is the single authority for the predicate vocabulary** (C-19). The `operator` enum in
[openapi.yaml](openapi.yaml) is generated from it and must not diverge; 004 contributes the closure
fields and references this table rather than describing predicate forms of its own.

| Field type | Permitted operators | Notes |
|------------|--------------------|-------|
| enumerated (`environment`, `issueKind`, `classification`, `actionClass`, `outcome`, `state`, `codeProblemVerdict`) | `equals`, `notEquals`, `in`, `notIn` | `in` takes a literal set declared in the rule; no wildcards |
| identifier (`componentId`, `targetRef`, `fingerprint`, `actionKey`) | `equals`, `in`, `notIn` | no hierarchy operator: reading the graph inside the fold made stored decisions unreplayable, because the graph mutates on every confirmation (C-16) |
| boolean (`complete`, `conclusionHasLink`, `reversible`, `hasTestedUndo`, `fixEligible`, `touches*`) | `isTrue`, `isFalse` | no implicit truthiness |
| ordinal (`autonomy` level, `degradationStep`) | `atLeast`, `atMost`, `equals` | a rule states the level it requires with `autonomy.level atLeast N` — there is no separate autonomy step in the evaluation order (C-17) |
| quantity (`consumed`, `limit`, `declaredMaxCost`, `cooldown.recentAllowCount`, `cooldown.attemptCount`, `escalation.attemptCount`) | `atLeast`, `atMost` | compared against a literal or against another field in the same group, never against a computed expression |
| instant (`evaluatedAt`) | `before`, `after` | compared only against a literal supplied in the rule; the evaluator reads no clock (R-02) |
| closure (`impact.closure`, an `ImpactClosure` from 004) | `containsNoneOf`, `subsetOf`, `sizeAtMost` (`size() <= n`), `maxDepthAtMost` (`maxDepth() <= n`) | antitone only: a larger closure may make a predicate harder to satisfy, never easier. `containsAnyOf`, `intersects` and `anyPathConfidence >= x` are absent, because an existential is satisfied *by adding an edge* (C-03, C-19, 004 R-05) |

Deliberately absent: regular expressions, substring matching, arithmetic and any operator over a
free-text field. Each of those is a route for collected content to reach a decision.

## Evaluation order

```text
1. resolve ruleset        current published version for the tenant (or the version named, on replay)
2. match                  every rule whose predicate conjunction holds — no ordering, no priority
3. fold                   max over ALLOW < REQUIRE_APPROVAL < DENY, seeded DENY   (FR-005, FR-006)
4. ceiling                min(level, ACTION_CEILING(actionClass, hasTestedUndo))  (FR-008)
5. budget                 exhausted → DENY(BUDGET_EXHAUSTED); degraded annotates  (FR-011, FR-012)
6. cooldown               rate, cooldown and attempt-cap counts over the window for
                          (actionKey, targetRef, fingerprint) → DENY(RATE_LIMITED ·
                          COOLDOWN · ATTEMPT_CAP_REACHED)                         (FR-014)
7. escalation cap         an *escalating* proposal whose escalation.attemptCount has reached
                          budget_limit.escalation_attempt_cap → DENY(ESCALATION_CAP_REACHED);
                          other proposals are never refused here, so a cap of 0 stops
                          escalation and nothing else                             (FR-013)
```

There is **no autonomy step**. A rule that requires a level says so itself, with
`autonomy.level atLeast N` (C-17): the level an action requires is a tenant's rule, visible and
reviewable where the rest of the rule set is, and nothing else ever defined it.

`ACTION_CEILING` is a function of the action class **and** of `hasTestedUndo` (C-18):
`reversible_remediation` has no level at all when the undo is unattested, so the one class with a
live L5 cannot reach it on an undo nobody has executed.

Steps 3 through 7 only ever make the outcome more restrictive. Nothing after step 2 can turn a
`DENY` into an `ALLOW`, which is the property that makes the ceiling un-exceedable regardless of
what any rule says.

## `EvaluationTrace`

Returned by both callers and stored on the decision, so a simulator report (011 FR-003) and an audit
entry describe the same decision in the same terms: matched rule keys, each matched rule's outcome,
the fold result, whether the ceiling bound, the resolved autonomy level, the budget state and the
reason codes. Reason codes are enumerated — a decision never explains itself in prose.

## Binding, consumption and validity

A persisted decision is bound to `(workflowRunId, workflowState, proposalDigest, rulesetVersion,
autonomyEpoch)` and is valid for exactly one execution:

- the executor presents the decision identifier and the digest of what it is about to do; a mismatch
  is `DIGEST_MISMATCH` and the action is refused;
- a second execution against the same decision is `DECISION_ALREADY_CONSUMED`;
- a decision whose own `outcome` is not `allow`, or one since invalidated, is never consumable —
  `DECISION_NOT_ALLOWED`, checked before the digest comparison, inside the same lock as the
  single-use check;
- **a decision is never carried across a wait.** Evaluation happens inside the job that performs the
  action, immediately before it, which is how a revoked grant takes effect at the next guarded step
  with no push mechanism (R-07, and the same instinct as 010 FR-004 for preconditions).

## Approval, and the one decision that does span a wait

`REQUIRE_APPROVAL` creates an `ApprovalRequest` and parks the workflow on 012's `approval` callback
(012 FR-029, 012 FR-030). The request records the tenant's `autonomyEpoch`.

```text
grant revoked ──▶ epoch bumped (one write) ──▶ every outstanding approval invalid at redemption
                                          └──▶ sweep resolves open requests to `revoked`,
                                               delivers the callback, run → needs_human
expiry        ──▶ workflow_run.deadline_at tick ──▶ request `expired`,
                                                   DENY(APPROVAL_EXPIRED) recorded, run → needs_human
```

The epoch makes the guarantee correct even if the sweep never runs; the sweep makes it prompt. No
path leads to the action proceeding (FR-016, SC-007), and there is no delegation.

## Events published through the outbox (012 FR-031)

Every event carries `tenantId`, `issueId`, `correlationId`, `occurredAt` and a schema version.
Past-tense names describe facts (001 `contracts/events.md`).

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `PolicyDecisionRecorded` | any persisted decision | decisionId, actionKey, outcome, rulesetVersion, reasonCodes | 001 (audit link), 011, dashboard |
| `ApprovalRequested` | outcome `require_approval` | approvalId, summary, expiresAt | notification, dashboard |
| `ApprovalResolved` | human approved or rejected | approvalId, resolution, resolvedBy | 008, 010, 011 |
| `ApprovalExpired` | deadline tick with no resolution | approvalId, workflowRunId | 001, dashboard |
| `AutonomyGranted` / `AutonomyRevoked` | grant created or revoked | scope, actionKey, level, epoch | 011, dashboard |
| `BudgetDegraded` | first crossing of a soft threshold | scope, periodKey, step, entryApplied, evidenceId | 003, 005, 006, 009, dashboard |
| `BudgetExhausted` | limit reached | scope, periodKey, consumed, limit | every AI path |
| `PolicyRulesetPublished` | new version published | version, digest, supersedesVersion | 011, dashboard |

`BudgetDegraded` carries the `evidenceId` of the record written for it (FR-012) rather than the
degradation text, so a consumer that wants to explain the reduced context reads the evidence
substrate rather than a copy of it.

## Events consumed

| Event | From | Effect |
|-------|------|--------|
| `AgentRunCompleted` | 012 | nothing is written; the row itself moves the budget aggregate (R-10) |
| `RemediationCataloguePublished` | 010 | re-derives reversibility and tested-undo facts for the action registry |
| `IssueStateChanged` | 001 | outstanding decisions bound to a run in a terminal state are invalidated |

## Error codes

`RULESET_INVALID` · `CEILING_EXCEEDED` · `UNDO_NOT_ATTESTED` · `DECISION_ALREADY_CONSUMED` ·
`DECISION_NOT_ALLOWED` · `DIGEST_MISMATCH` · `STALE_AUTONOMY_EPOCH` · `APPROVAL_NOT_PENDING` ·
`BUDGET_EXHAUSTED` · `RATE_LIMITED` · `COOLDOWN` · `ATTEMPT_CAP_REACHED` ·
`ESCALATION_CAP_REACHED` · `NO_MATCHING_RULE` (the reason code accompanying the default `DENY`, so that "no rule matched" is a
recorded fact rather than an absence).
