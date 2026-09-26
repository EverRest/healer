# Contract: the remediation action catalogue

Normative. The catalogue is closed: the six proposable entries below are the whole of it — plus the
undo-only key `deployment.restore_dispatch_version` (C-15), which no caller may propose — and a
seventh proposable action is a change to [spec.md](../spec.md) followed by a release, never a
configuration change (R-01). Every entry declares four things; an entry missing one does not load
(FR-002).

**The undo attestation is what 002 reads as `hasTestedUndo`.** Each entry's `undo_attestations` row
in the published catalogue version — written by the undo test run, naming the catalogue digest and the
build (R-02) — is published on `RemediationCataloguePublished` ([events.md](events.md)) and is the sole
source of that fact. Under C-18 `ACTION_CEILING` is `f(actionClass, hasTestedUndo)` and
`reversible_remediation` has **no autonomy level** while the undo is unattested, so dropping an
attestation lowers the ceiling for that action rather than leaving a permission behind it cannot
justify. Nothing in this feature asserts reversibility any other way.

Column meanings are fixed:

- **Precondition** — deterministic predicates re-evaluated immediately before execution, not only at
  proposal (FR-004). Every action additionally inherits the common preconditions below.
- **Action** — the parameter schema. Nothing outside it can be expressed.
- **Verification** — the anchor, which must pre-date the issue (R-03).
- **Undo** — resolved and persisted at dispatch, before the mutation (R-05).
- **Blast radius** — the declared bound; exceeding it refuses the proposal, never truncates it
  (FR-014, R-12).

## Common preconditions — every action

| Predicate | Refusal |
|-----------|---------|
| Target carries an eligibility entry for this action **and** every declaration that action requires (FR-015, R-17) | `TARGET_NOT_ELIGIBLE` |
| No open `target_block` for the target (FR-019) | `TARGET_BLOCKED` |
| No attempt in `dispatched` or `awaiting_verification` for the target (FR-012) | `TARGET_BUSY` |
| Runner declares the capability for this action (R-14) | `CAPABILITY_UNAVAILABLE` |
| Policy returned `ALLOW`, or `REQUIRE_APPROVAL` that was granted (002 FR-001, FR-007) | `POLICY_DENY` |
| The attempt references the diagnosis or correlation evidence justifying it (FR-018) | `JUSTIFICATION_MISSING` |

**Rate limits, cooldowns and attempt caps are not in this list (C-11).** They are 002's, evaluated
inside the policy decision over the `targetRef` and `fingerprint` this feature supplies on
`DecisionInput`, and they reach the tenant here only as a **projection**: a `POLICY_DENY` whose reason
code is `RATE_LIMITED`, `COOLDOWN` or `ATTEMPT_CAP` is recorded on the attempt under that code, so
"nothing happened and here is why" still reads the same. Evaluating them a second time in this feature
would be two stores with two keys, neither authoritative.

## The six actions

### `deployment.rollback`

| | |
|---|---|
| **Precondition** | a prior deployment exists in the target's own history; it is not marked known-bad; no irreversible schema migration lies between it and the current deployment (FR-022) |
| **Action** | `{ targetId, previousDeploymentId }` — `previousDeploymentId` **must resolve inside the target's deployment history and precede the current deployment**. There is no image, tag, branch or version field, so a forward deploy is not expressible (R-04, 002 FR-008) |
| **Verification** | `production_metric` — the error-rate or latency series named in the issue's correlation evidence, baseline taken from a window closing before `issue.first_seen_at`, expected `return_to_baseline` |
| **Undo** | the separate action key **`deployment.restore_dispatch_version`** (C-15), not `deployment.rollback` again. Its single parameter must equal the attempt's `revision_ref_at_dispatch` |
| **Blast radius** | one `DeploymentUnit`; components served by it, widened by unconfirmed graph edges only (C-03, 004 FR-016a) |

Rollback's undo cannot be rollback. `deployment.rollback`'s schema requires a deployment that
**precedes** the current one (R-04), and undoing a rollback means returning to the deployment that
*succeeded* it — which that schema cannot name, and must not be able to, or a forward deploy becomes
expressible. So the undo is its own key:

### `deployment.restore_dispatch_version` — undo only, not proposable

| | |
|---|---|
| **Precondition** | the named revision is the attempt's own `revision_ref_at_dispatch`, and it is still resolvable in the target's deployment history |
| **Action** | `{ targetId, revisionRef }` — **exactly one parameter beyond the target, and it must equal `remediation_attempt.revision_ref_at_dispatch`.** It can name exactly one deployment: the one this attempt moved away from. There is no image, tag, branch or version field, and no way to supply any other revision |
| **Verification** | the same anchor the rollback declared, re-sampled: the window that closed `not_improved` reopens against the pre-incident baseline |
| **Undo** | none, and none is admissible — this *is* the undo. A failure here is `undo_failed`: the target is blocked and the issue escalates (FR-019, R-09) |
| **Blast radius** | identical to the rollback it undoes, by construction — the same `DeploymentUnit` |

No proposal path accepts this key, no `remediation_target_eligibility` row is written for it, and it
appears in `remediation_directive` only with `mode: "undo"`. It is in the catalogue because it needs a
parameter schema, a precondition and an undo attestation like everything else — not because a caller
may choose it. The forward catalogue is still the six actions.

### `workload.restart`

| | |
|---|---|
| **Precondition** | healthy replica count after the restart stays at or above the declared minimum; the workload is not mid-rollout |
| **Action** | `{ targetId, scope: 'instance' \| 'workload', instanceRef? }` |
| **Verification** | `pre_existing_healthcheck` returning healthy for the declared settling period, plus the issue's own signal series |
| **Undo** | `restore_prior_replica_state` — scale to the healthy replica count observed in the precondition, captured at dispatch. **Trigger**: the restart leaves fewer healthy replicas than the precondition observed. **Attestation test** (R-18): record a healthy count, restart into a state with fewer, assert the undo restores the count |
| **Blast radius** | instance count; never more than the declared fraction of a workload's replicas |

### `feature_flag.disable`

| | |
|---|---|
| **Precondition** | the flag is marked remediable by the tenant; it is not referenced as a kill switch by another declared system; its current value is not already disabled |
| **Action** | `{ targetId, flagKey, scope }` — scope limited to the flag's declared remediable scope |
| **Verification** | `production_metric` on the series correlated to the flag's rollout, or a `pre_existing_test` covering the behaviour the flag gates — **executed in the customer's execution plane, in 007's sandbox, against the deployed revision's commit**, never in the control plane and never against production credentials (007 FR-011, D-16). A tenant whose sandbox cannot reach the flag's evaluation path has only the metric anchor available |
| **Undo** | restore the exact prior value and scope, captured at dispatch |
| **Blast radius** | one flag, one declared scope; a flag with no declared scope is not remediable |

### `service.scale`

| | |
|---|---|
| **Precondition** | requested delta within the declared bound; resulting count within the target's declared minimum and maximum; no scaling operation in flight |
| **Action** | `{ targetId, replicaDelta }` — a delta, not an absolute count, so a bound is expressible |
| **Verification** | `production_metric` — saturation, queue latency or error rate named at proposal, expected `decrease` against a pre-incident baseline |
| **Undo** | scale by the inverse delta to the replica count observed at dispatch |
| **Blast radius** | `maxReplicaDelta` per action and per tenant |

### `queue.drain`

| | |
|---|---|
| **Precondition** | the queue is in the tenant's eligible set; the target's declared `holding_destination` **passes the queue adapter's `probeHolding` check — a write of a canary message followed by its read-back and deletion, recorded in `prior_state`**; message count within the declared bound. An unprobed or failing destination refuses the action: a drain into a destination nobody could write to is the deletion FR-021 forbids, arriving by another route |
| **Action** | `{ targetId, maxMessages, holdingRef }` — **move to holding**. Deletion is not in the schema (FR-021) |
| **Verification** | `production_metric` — consumer error rate or processing latency returns toward its pre-incident baseline |
| **Undo** | restore the moved messages from holding, in order, by the batch identifier recorded at dispatch |
| **Blast radius** | `maxMessages`; a queue whose depth exceeds the bound is refused, never partially drained |

### `job.retry`

| | |
|---|---|
| **Precondition** | the job is in a terminal stuck state, not running; it is declared idempotent by the tenant; retry count below the declared cap |
| **Action** | `{ targetId, jobRef }` |
| **Verification** | `production_metric` — the consumer error rate for the job's queue, or a downstream completion metric (processed count, backlog age), against a baseline window closing before `issue.first_seen_at`; where neither series exists for the tenant, `pre_existing_healthcheck` on the consumer. **The job's own terminal success state is a precondition for closing the window, never the anchor** |
| **Undo** | cancel the retried execution and restore the prior job state recorded at dispatch |
| **Blast radius** | one job; batch retry is not in the catalogue |

`job.retry`'s verification was originally "the job reaches a terminal success state" — the action's own
output. That breaches Principle II and FR-005, and it is also **not expressible**: `anchor_kind` is a
closed enum of `production_metric`, `pre_existing_healthcheck` and `pre_existing_test` with no member
for the action's own report (R-03), so the catalogue loader would reject the entry and `job.retry`
would never load. The job's terminal state still matters, as a gate on *closing* the window — a window
cannot close `improved` while the job is still running — but the claim that the retry helped is made by
a signal that existed before the incident, like every other action's.

## Actions deliberately absent

| Not in the catalogue | Why |
|----------------------|-----|
| Delete queue messages | the undo would be "the data is gone" (FR-021) |
| Forward deploy, including "deploy the fix" | outside the L2 ceiling (002 FR-008); not expressible by any schema here (R-04) |
| Database write, migration or rollback of a migration | not reversible by construction; migration-bearing deployments leave the class entirely (FR-022) |
| Config edit, secret rotation, DNS or traffic-weight change | no declared undo that restores prior state observably within a verification window |
| Arbitrary command, script or manifest apply | the control plane never sends a shell command (FR-009, 012 runner protocol) |

## Directive shapes

Carried by the `remediation_directive` entry of
[012 `contracts/runner-protocol.md`](../../012-engineering-foundation/contracts/runner-protocol.md).

```text
remediation_directive
  invocationId    uuid        # idempotency key; a repeat applies nothing (FR-010)
  mode            "dry_run" | "execute" | "undo"
  actionKey       enum        # from the catalogue version named below
  catalogueDigest string
  targetRef       { kind, platformRef, environment }
  parameters      object      # validated against that action's schema; no free-form strings
  limits          { blastRadius, timeoutSeconds }
```

`mode: "dry_run"` is dispatched with the inspection capability only; the runner's action module
reaches `plan()` and has no handle capable of calling `apply()` (R-10).

Every dispatch in `mode: "execute"` or `mode: "undo"` is performed by a function taking a
**`RemediationDispatchCapability`** as an argument, resolvable from no dependency-injection container,
module import, ambient configuration or global
([ADR 0008](../../../docs/adr/0008-capability-passing.md), FR-009). A run constructed without it —
every simulation run (011 R-01) — cannot reach the dispatch path rather than choosing not to.

### What `mode: "undo"` re-runs, and what it does not

`mode: "undo"` carries the directive stored at dispatch, verbatim (R-05). Explicitly:

- **Parameter schema validation: yes.** The directive is validated at ingress like any other, in the
  execution plane, against the undo action key's own schema. A stored directive is still untrusted
  input by the time it crosses the boundary, and for `deployment.restore_dispatch_version` the
  validation includes the equality check against `revision_ref_at_dispatch` (C-15).
- **The undo action's own execution-time precondition: yes**, where it declares one — the named
  revision must still be resolvable, the prior replica count must still be a legal target.
- **The common preconditions: no.** Eligibility, `TARGET_BUSY`, the runner capability check, the
  justification check and a fresh policy evaluation are **not** re-run. The undo is the completion of
  an attempt that was already authorised, and every one of those checks would refuse it exactly when
  it is needed: the attempt itself holds the `TARGET_BUSY` row, a grant revoked mid-window would leave
  a failed production change standing, and an attempt cap reached by the very attempt being undone
  would forbid undoing it. An undo that policy can block is not an undo, and FR-002's reversibility
  claim would be decoration.
- **`TARGET_BLOCKED`: not applicable.** A block is opened *by* an undo failure (R-09), so no block
  exists at undo dispatch; an undo against an already-blocked target is the `undo_failed` terminal
  state, not a refusal.

## Result shape — runner to control plane

Structured evidence only; the closed list of 012 FR-022 applies unchanged (FR-025).

```text
remediation_result
  invocationId    uuid
  outcome         "applied" | "refused" | "failed" | "planned"
  refusedBy       string?     # which precondition, evaluated in the execution plane
  priorState      object      # structured, bounded — replica counts, flag value, deployment id
  observedState   object      # after the operation; absent when unreadable
  revisionRef     string?     # platform revision counter (R-13)
  metricDeltas    array       # metric_delta evidence shapes
  operationRefs   string[]    # the platform's own operation identifiers
  durationMs      integer
```

**Never crosses**: raw log bodies, manifests, command output, environment variables, connection
strings, message payloads from a drained queue. A drain reports counts and batch identifiers, never
message contents.

## Refusal is a result, not an error

Every refusal — precondition, limit, eligibility, block, capability, policy — returns a structured
outcome naming what refused it, and is recorded as an attempt in state `refused` with its reason.
A refusal that is only a log line cannot be shown to the tenant who needs to know why nothing
happened (002 FR-015).
