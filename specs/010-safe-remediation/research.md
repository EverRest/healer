# Phase 0 Research: reversible production actions

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · The catalogue is code; only its bindings are configuration

**Decision**: the six action definitions are modules in `packages/domain/remediation/domain/catalogue/`,
and the action key set is a TypeScript union. What a tenant configures is which targets are eligible
for which action, the numeric limits, and the autonomy grants (002 FR-007). What a tenant cannot
configure is which actions exist, what they do, how they are verified, or how they are undone. The
catalogue's content digest is published as an append-only `remediation_catalogue_version` row at
release, the same shape the prompt registry uses (012 R-07), and every attempt records which version
produced it.

**Rationale**: "closed catalogue" has to mean something a year from now, when a customer asks for a
seventh action during an incident. If the catalogue were a table, the answer would be a row, and the
row would carry no undo test, no blast-radius bound and no adapter. As code, adding an action is a
spec change, a release and a passing undo test — which is the point.

**Alternatives**: a catalogue table with a schema per action (makes the safety properties
declarative claims rather than executed tests); a plugin interface (an extension point nobody asked
for, and a supply chain into production).

## R-02 · The undo test is an admission gate, attested by the test run

**Decision**: an action is admitted to the catalogue only when the current build carries an
attestation that its undo executed successfully — the test run writes the attestation naming the
catalogue digest and the build identifier, and the catalogue loader refuses an action whose
attestation does not match the running build. `gate-undo` (012 FR-014) enumerates the catalogue and
fails when any action lacks a test exercising precondition, action, verification and undo
(002 SC-005).

**Rationale**: FR-003 requires the undo to have run successfully *within the current release*. A
gate that checks a test file exists proves that a file exists. Attestation produced by execution is
the difference between "there is a test" and "the undo worked on this build".

**The attestation is also 002's `hasTestedUndo` (C-18).** `ACTION_CEILING` becomes
`f(actionClass, hasTestedUndo)`, and `reversible_remediation` — the one class with a live L5 — has no
level at all while the undo is unattested. 002 derives that fact from the `undo_attestations` payload
of `RemediationCataloguePublished` ([contracts/events.md](contracts/events.md)) and from nowhere else:
this feature publishes no reversibility flag, and 002 stores no reversibility column (002 R-06). So a
release that changes an action's code without re-running its undo test does not merely fail to load the
action — it also removes the autonomy level that action could have been granted, which is the direction
a missing proof should push.

**Alternatives**: checking for a test file by naming convention (passes for a skipped test); trusting
the CI job's green status (does not survive a partial re-run).

## R-03 · A verification anchor that points at the action's own output is not representable

**Decision**: each action's verification declaration names an anchor of kind `production_metric`,
`pre_existing_healthcheck` or `pre_existing_test`, a selector, a baseline window that must close
**before** `issue.first_seen_at`, and an expected direction and magnitude. There is no enum member
for the action's own report, and there is no free-form anchor field. Catalogue load rejects a
verification whose baseline window overlaps the incident.

**Rationale**: constitution II, applied to an action rather than a patch. "The rollback reported
success" is the action verifying itself, and it is the failure this product cannot have. Making the
dangerous anchor absent from the type is the same move as 012's single-valued `fallback_scope`: the
wrong configuration should not be expressible, not merely defaulted away.

**Consequence for `job.retry`.** "The job reaches a terminal success state" is the action's own output
and has no member in the enum, so the entry as first written would be **rejected by the loader** —
which is the mechanism working, not a gap in it. Re-anchored: consumer error rate for the job's queue,
or a downstream completion metric (processed count, backlog age) against a pre-incident baseline, or a
`pre_existing_healthcheck` on the consumer where neither series exists. The job's own terminal state is
kept as a **precondition for closing the window** — a window cannot close `improved` while the retry is
still running — which is a gate on the observation, never the observation itself.

**Alternatives**: a reviewer checking anchors at definition time (survives until the first hurried
action); a runtime warning (a warning on the path to production is a log line).

## R-04 · Rollback is not a forward deploy, structurally

**Decision**: the rollback action's parameter schema accepts a `previousDeploymentId` that must be
resolved by the deployment adapter from the target's own deployment history and must precede the
current deployment in that history. There is no artifact reference, no image tag, no branch and no
version string in the schema. A version that is not already in the target's history cannot be named,
so a forward deploy cannot be expressed by any caller, model or human.

Preconditions additionally refuse the action when there is no prior deployment, when the prior
deployment is marked known-bad, and when the range between the two carries an irreversible schema
migration (FR-022). Migration-bearing deployments leave the reversible class entirely and require an
approval with a human plan.

**Rationale**: 002 FR-008 draws the line between the L2 ceiling and the reversible class in prose.
Prose is the wrong place for it — the first time a model proposes "roll back to the fixed version"
the distinction has to hold mechanically. A schema that can only name history cannot deploy
forward.

**Alternatives**: a policy rule comparing the proposed version to the current one (a rule is a
predicate over a field that should not exist); a validator on a free-form version string (parses
version strings for a living, and eventually parses one wrong).

## R-05 · The undo plan is captured before the mutation, not derived after it

**Decision**: dispatching an action persists, in the same transaction, the observed prior state and
the fully-resolved undo directive — action key, target, parameters, all literal. The undo is later
dispatched from that stored row. It is never recomputed from the target's current state.

**Rationale**: the undo runs precisely when the action made things worse, which is when the target is
least likely to answer a query correctly. An undo derived from post-failure state can legitimately
compute "restore to the state I am observing", which is the broken one. Capturing it at dispatch
also makes the undo plan showable in the approval request (002 FR-015) and in the dry-run, because it
is the same data.

**Alternatives**: recomputing the undo at failure time (fails in the only scenario it exists for);
having the executing action return its own undo (an undo authored by the step that broke things).

## R-06 · The verification window is a persisted state plus a tick callback

**Decision**: after a result is recorded, the workflow enters `awaiting_verification` with a
`deadline_at` and a `verification_tick` callback registered (012 `workflow_callback`, FR-030). Each
tick samples the anchor and writes the observation as an evidence record emitted by the verification
step (001 FR-008). The window closes on `improved`, on the deadline with `not_improved`, or on the
deadline with `inconclusive` when the anchor could not be sampled. `not_improved` and `inconclusive`
are treated identically: both trigger the undo and reopen the issue (FR-006).

**Rationale**: the constitution forbids waiting inside a job, and a ten-minute verification window is
exactly the wait that tempts someone to sleep in a worker. Treating an unobservable signal as a
failure is the conservative reading and the only honest one — an action nobody can verify has not
been verified.

**Alternatives**: a long-lived worker sampling the metric (ADR 0003 exists to prevent this); treating
`inconclusive` as success pending human review (leaves an unverified production change standing).

## R-07 · Serialisation per target is a database constraint

**Decision**: `remediation_attempt` carries a unique partial index on `(tenant_id, target_id)` for
states `dispatched` and `awaiting_verification`. A second mutation against a live target fails to
insert and is refused with the in-flight attempt named. Dry-runs are not covered by the index because
they mutate nothing.

**Rationale**: FR-012 is a correctness property, and correctness properties belong in the store that
has to hold them. A Redis lock has a TTL, and the TTL expires during exactly the slow action the lock
was protecting; a second dispatch then lands mid-verification and both outcomes become
unattributable.

**Alternatives**: advisory locks (invisible in the audit trail, lost on connection drop); an
application-level in-flight check (a race between check and insert).

## R-08 · Recurrence is counted per target and fingerprint, not per issue

**Decision**: the attempt cap and the cooldown are evaluated over attempts sharing
`(tenant_id, target_id, issue_fingerprint)` within a rolling recurrence window, and the escalation
carries every attempt in that group with its interval and evidence (FR-016). The issue identifier is
recorded but is not the counting key.

**Who evaluates it (C-11).** 002 does. This feature owns the *key* and the escalation payload; it does
not own the counter. Every proposal supplies `targetRef` and `fingerprint` on `DecisionInput`, and the
cap, cooldown, rate limit and recurrence window are 002's stored configuration evaluated in its
decision (002 FR-013, FR-014). `remediation_limit` is deleted, and this feature keeps only the
projection: an attempt refused by a decision carrying `ATTEMPT_CAP`, `COOLDOWN` or `RATE_LIMITED` is
recorded under that code. SC-011 is then a property of 002's decisions read through this feature's
attempt rows, which is also why it is stated over groups rather than over issues.

**A mixed-action group.** The group is action-agnostic while `attempt_cap` is keyed
`(tenant, action_key)`, so a group holding a restart, a scale and a drain has three candidate caps. The
governing cap is the **minimum over the action keys present in the group**. A target being relieved by
three different remediations in one window is a stronger recurrence signal than one being restarted
three times — the system is finding new ways to keep the same broken thing alive — so the group should
escalate at the most cautious bound, not the most permissive. Taking the maximum, or the cap of the
action currently proposed, lets an operator extend a loop indefinitely by alternating actions, which is
the loop this cap exists to stop.

**Rationale**: a recurring failure outside the reopen window creates a **new** issue (001 FR-005,
001 R-02). A cap counted per issue therefore resets on every recurrence and never fires — in the
restart-loop scenario the cap exists and is structurally blind to the only pattern it was written
for. The fingerprint is stable across those issues by construction (001 FR-002), which makes it the
correct key.

**Alternatives**: counting per issue (blind in the loop case); counting per target alone (conflates
two unrelated failures on one busy component and escalates the wrong thing).

## R-09 · An undo failure blocks the target, and the escalation reports observed state

**Decision**: a failed undo writes both the verification failure and the undo failure as evidence,
opens a `target_block` row naming the reason, and escalates immediately. While a block exists, every
action against that target — not only the one that failed — is refused at proposal, and a block is
cleared only by a named human, recorded. The escalation carries the target's **last observed** state,
and where the state could not be read it says so rather than reporting the intended state.

**Rationale**: the undo failing is the event that converts a safe action class into an unsafe one,
and the only correct behaviour is to stop. Blocking only the failed action type would permit the
next automated attempt on a target whose state is now unknown. Reporting intent instead of
observation is how an on-call engineer ends up debugging a system that is not in the state the
handoff described.

**Alternatives**: retrying the undo (a second mutation against a target in an unknown state);
blocking only the failed action (leaves five other ways to touch it).

## R-10 · Dry-run is a different capability, not a different argument

**Decision**: each action module exports `plan()` and `apply()`. `plan()` receives a read-only
platform handle whose type has no mutating methods, and it is what produces the resolved target,
observed current state, blast radius, verification plan, undo plan and the dry-run policy decision
(002 FR-019). The runner grants the inspection capability for a dry-run directive and the mutation
capability only for an execute directive. A dry-run never reaches `apply()`, because it has nothing
to call it with.

**Rationale**: a dry-run whose safety is a boolean parameter is one wrong branch away from being an
execution, and the branch is in the hot path of the code that mutates production. SC-005 is verified
against the target environment's own audit log rather than ours, because our record of having done
nothing is not evidence.

**Alternatives**: `apply(params, { dryRun: true })` (one negated condition from disaster); a
simulated adapter (dry-run must report *observed* current state, so it has to read the real system).

## R-11 · A remediation mitigates; only production verification resolves

**Decision**: a verified remediation writes a mitigation record and evidence, never `IssueResolved`.
For an issue whose classifier verdict is `NOT_A_CODE_PROBLEM` (006 FR-001, FR-002), the issue is
eligible for resolution on production verification like any other. For an issue classified as a code
problem, the issue returns to its investigation state carrying `mitigated_at`, and the code path
continues (FR-017).

**Rationale**: restarting a worker that leaks memory does not fix the leak, and an issue closed by
the restart is a bug that will be rediscovered, rediagnosed and re-paid for. A remediation that
silently closes code problems turns the product into a machine for hiding them.

**Alternatives**: closing the issue and raising a follow-up (the follow-up carries none of the
evidence and nobody prioritises it); a `mitigated` terminal state (terminal means nobody looks
again).

## R-12 · Blast radius is refused, never truncated, and eligibility is opt-in

**Decision**: each action declares a bound — replica delta, message count, affected target count,
flag scope — evaluated against the resolved target and the blast-radius query over the architecture
graph (004 FR-015). A proposal exceeding the bound is refused with the limit named. A target not
carrying an eligibility entry for that action type is refused, and eligibility is created only by a
tenant action. An unconfirmed graph edge may widen the computed radius, never narrow it
(004 FR-016a, C-03).

**Rationale**: truncating to fit executes a different action than the one that was evaluated, and the
policy decision recorded alongside it then describes something that did not happen. Opt-in
eligibility is what stops a correct action from being applied to a target whose owner never agreed
to it — the kill-switch flag case.

## R-13 · External change is detected by the platform's own revision counter

**Decision**: dispatch records the target's platform-supplied revision identifier — deployment
identifier, workload generation, flag version — and every verification tick re-reads it. A revision
that changed and is not attributable to our invocation identifier invalidates the verification and
escalates (FR-020). The outcome is never attributed to the remediation.

**Rationale**: a human rolling back manually during our verification window would otherwise be
recorded as our success, and that false record becomes benchmark input, threshold input and a sales
claim. Using the platform's counter rather than a hash of observed state avoids a verification that
fails whenever a replica restarts on its own.

**Alternatives**: hashing observed state (noisy, invalidates constantly); ignoring external change
(silently claims other people's work).

## R-14 · A missing adapter makes an action unavailable, never approximate

**Decision**: remediation capabilities are state-changing, so a runner that does not declare the
capability for an action causes refusal with a stated reason, never a degraded execution
(012 FR-018, 012 R-03, C-02). The catalogue surface returned to a tenant lists an action without
adapter support as unavailable with the reason.

**Rationale**: this is the rule the runner protocol already establishes, and remediation is the
sharpest case of it: a mutation executed by older or partial logic is the failure the compatibility
floor exists to prevent.

## R-15 · What the MTTR carve-out actually measures

**Decision**: the recorded measure is `time_to_verified_remediation` — issue creation to a
verification window closing `improved` — stored per attempt. It is never aggregated into a
product-wide MTTR figure, and the field is named for what it measures.

**SC-010 is measured on live tenant data, not on the benchmark.** The comparison against time to a
merged code fix is reported over a tenant running at L2 or above, with an availability tri-state of the
same shape as 011's `revert_rate_30d` (011 R-09) — `available` · `insufficient_observation` ·
`not_applicable` — and "materially shorter" means the median is at most half. A replay cannot produce
either side of the comparison: a simulation holds no `RemediationDispatchCapability`, so it dispatches
no remediation and closes no verification window, and nothing is merged in a replay, so there is no
merged-fix time either. Handing the measure to 011 would have handed it a metric key its enum does not
contain, computed over populations a run never produces — a number that would exist only as a task
pointing nowhere.

**Rationale**: D-19a grants MTTR as a legitimate metric for this surface alone, precisely because
this surface acts autonomously. That is also why the measure has to come from the surface acting: a
benchmark figure for an autonomous action nobody performed is the flattering reading D-19a was written
to prevent. Naming the column `mttr` would make the unqualified claim inevitable the first time someone
builds a dashboard from the schema.

## R-16 · Escalation is a state transition plus an event, not a new transport

**Decision**: escalation moves the issue to `needs_human` (001) and publishes
`RemediationEscalated` through the outbox, carrying the attempt history, the observed state and the
reason. Delivery is whatever subscribes — the dashboard, a webhook, a chat integration. This feature
owns the payload and the transition; it owns no transport.

**Rationale**: FR-016 and FR-019 require an escalation that *carries* something, and the temptation is
to build a notifier here. Every feature that escalates would then have its own, and the fourth one
would be inconsistent with the first three. The outbox already exists (012 FR-031) and the dashboard
already renders issues in `needs_human`.

**Alternatives**: a notification service in this feature (a transport per feature); reusing 002's
approval flow (an approval asks for permission to proceed; an escalation reports that nothing more
will be attempted — opposite meanings).

## R-17 · Per-target bounds live on the target, declared before the action is eligible

**Decision**: `remediation_target` carries the bounds each action class needs, and an action is not
eligible for a target whose required bounds are unset:

| Action | Required declaration on the target |
|--------|-----------------------------------|
| `workload.restart` | `min_healthy_replicas` |
| `service.scale` | `min_replicas`, `max_replicas` |
| `feature_flag.disable` | `remediable_flag_keys` (an allowlist, never "all flags") |
| `queue.drain` | `holding_destination` |
| `job.retry` | `idempotency_declared` (boolean, tenant-asserted) |
| `deployment.rollback` | none — history supplies the bound (R-04) |

These are columns on `remediation_target` (data-model), nullable, where **null means undeclared — not
zero and not false**.

**Eligibility is a conjunction, not a computation** (amended; the earlier wording "computed, not
stored" contradicted FR-015's stored opt-in row and left the columns unwritten). An action is available
for a target when **both** hold: a stored `remediation_target_eligibility` row exists for
`(target, action)`, **and** every declaration that action requires is present. A target with
`min_healthy_replicas` unset has no `workload.restart` available even with an opt-in row; a target with
the declaration but no opt-in row has none either.

**Rationale**: these bounds are the difference between a remediation and an outage. `job.retry`
without an idempotency assertion can double-charge a customer; `feature_flag.disable` without an
allowlist can turn off authentication. The conjunction keeps both halves meaningful: the opt-in is the
tenant agreeing that this action may touch this target, and the declaration is the bound it must
respect — an opt-in alone is agreement to something whose bound is unknown, which is the case a
"computed" eligibility would have silently permitted once the columns did not exist.

## R-18 · `workload.restart`'s undo is a scale-up to the previous healthy count

**Decision**: the declared undo for `workload.restart` is `scale to the healthy replica count observed
in the precondition`. It runs when the restart leaves fewer healthy replicas than before. The
`gate-undo` attestation test exercises exactly that: record a healthy count, restart into a state with
fewer, assert the undo restores the count.

**Rationale**: FR-003 and the admission gate require a passing undo test per action, and "no undo is
required because a restart is harmless" is how a restart loop becomes an outage. A restart that does
not come back is the failure mode, and scaling to the previously observed healthy count is the
recovery an operator would perform. The catalogue's normative cell said both things at once — "none is
required" followed by a named undo — and the first half is now deleted: the undo is
`restore_prior_replica_state`, its trigger is *fewer healthy replicas than the precondition observed*,
and its attestation test is the one above.

## R-19 · Rollback's undo is a separate, undo-only action key

**Decision**: the undo for `deployment.rollback` is the action key
`deployment.restore_dispatch_version` (C-15). Its parameter set is `{ targetId, revisionRef }`, and
`revisionRef` **must equal the attempt's `revision_ref_at_dispatch`** — validated when the directive is
ingested in the execution plane, so it names exactly one deployment: the one this attempt moved away
from. The key is loadable, attested and dispatchable only with `mode: "undo"`; it is not proposable, no
eligibility row is written for it, and no caller can select it.

`mode: "undo"` re-runs **parameter schema validation** (a stored directive is still untrusted input by
the time it crosses the boundary) and the undo action's **own execution-time precondition**. It does
**not** re-run the common preconditions: eligibility, `TARGET_BUSY`, the runner capability check, the
justification check or a fresh policy evaluation. Every one of those would refuse the undo exactly when
it is needed — the attempt itself holds the busy row, a grant revoked mid-window would leave a failed
production change standing, and the attempt cap reached by the attempt being undone would forbid
undoing it.

**Rationale**: the flagship action had no admissible undo. `deployment.rollback`'s schema requires a
deployment that *precedes* the current one (R-04) and undoing a rollback names the one that *succeeded*
it, so reusing the key means either failing its own precondition or widening the schema until a forward
deploy is expressible — and keeping forward deploy inexpressible is the whole of R-04. A separate key
with one constrained parameter keeps both properties: it can name exactly one deployment, and it can
name no other.

**Alternatives**: widening `deployment.rollback` to accept any revision in history (a forward deploy is
then one parameter away, and the L2 ceiling becomes a convention); recomputing the undo target from the
platform's current state (R-05 rejects this for every action, and here it would restore the state that
just failed verification); declaring rollback irreversible and requiring approval for it (removes the
one autonomous action D-14 exists for).

## Unresolved

None.
