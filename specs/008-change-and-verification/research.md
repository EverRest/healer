# Phase 0 Research: impact analysis, TDD fix, independent verification, pull request

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · The change graph is computed where the source is

**Decision**: ts-morph runs inside the runner, in the customer's execution plane. What crosses to the
control plane is the graph itself — typed nodes and edges with their derivation — never file
contents. The `change_plan` directive already crosses in the other direction
(012 `runner-protocol.md`); `change_graph` **must be added** to that contract's closed evidence shape
list as nodes and edges with repository-relative paths and symbol names only. It is not there today and
007 R-17 adds nothing either, so this is a cross-feature addition raised against 012 FR-022 — see
[data-model.md](data-model.md) "Cross-feature additions" — not something to smuggle through
`tool_output_summary`.

**Rationale**: a call graph needs the whole project. Shipping the source to the control plane to
build it would undo the deployment model in the one feature that touches the most sensitive asset
the customer has. Symbol names and paths are already permitted to cross (012 FR-022, `file_path`);
bodies are not.

**Alternatives**: central analysis over a mirrored repository (recreates the thing hybrid deployment
was sold to avoid, and the mirror is a second attack surface); asking a model to infer the graph from
excerpts (the graph would then be an opinion, and FR-001 requires it to be a parse).

## R-02 · A model cannot remove an edge, because removal is not representable

**Decision**: `change_graph_edge` is append-only within an analysis, and every row carries
`derivation` from a closed set — `symbol_reference`, `type_graph`, `call_graph`, `contract`,
`db_model`, `migration`, `test_map`, `event_topic`, `feature_flag`. Model output lands in
`change_graph_annotation`, which may only **add** an edge (marked `derivation = model_inferred`) or
attach a note to an existing one. There is no update and no delete path, and no query in the feature
filters deterministic edges by any annotation field. A model-inferred edge may widen blast radius and
raise classification; it may never narrow or lower (004 FR-016a, C-03).

**Rationale**: FR-002 says a model may interpret but not remove. Expressed as a rule, that survives
until someone adds a convenient `suppressed` flag for noisy edges. Expressed as a schema with no
delete, the violation requires a migration and a review.

**Alternatives**: an `active` boolean set by the model (a delete wearing a different name); a
reconciliation step that resolves disagreements (whoever writes the resolver decides the precedence,
and it will eventually favour the more readable answer).

## R-03 · Classification consumes touched facts; size is not a field on its input

**Decision**: the classifier input is a set of boolean touch predicates derived from the graph —
`touches_public_contract`, `touches_db_migration`, `touches_authn_authz`, `touches_money_path`,
`crosses_component_boundary`, `touches_shared_library`, `touches_feature_flag`,
`touches_event_contract` — each with the graph path that established it (004 FR-015). Tier is the
maximum over a versioned predicate→tier table. The input type contains **no** file count, line count
or diff size; the classifier cannot read what it is not given.

**Rationale**: SC-008 demands a one-line auth change outrank a thirty-file rename in 100% of cases.
A weighting that includes size will eventually cross over at some file count, and the crossover point
will be discovered in production.

**Alternatives**: a scored model with size as one weak feature (the crossover exists, it is just
harder to find); a human-authored per-path risk map (stale the first refactor, and it hides the
reason behind the tier).

## R-04 · Anchor resolution is deterministic, and 006 is not trusted for it

**Decision**: a non-agent `AnchorResolver` step queries 005 for expectations covering the diagnosed
behaviour and returns one of `ANCHORED`, `NO_EXPECTATION`, `ADOPTED_AFTER_ISSUE`, `REVOKED`,
`VERSION_NOT_READOPTED`. `ANCHORED` requires: a live `anchor_grant` naming the expectation version —
**not** a `state = adopted` predicate (C-12), because the grant is the only thing that can name an
anchor and `state` is a display column no anchor query reads; an `adoption_record` with
`actor_type = human` (005 FR-011); `adopted_at < issue.first_seen_at`; the granted version is the
version the test will assert against (005 FR-012); the grant not revoked at resolution time
(005 FR-013). The resolution stores `anchor_grant_id` `NOT NULL` for `ANCHORED` plus **immutable
copies** of `adopted_at` and `adopted_by_actor_type`, so the comparison stays reconstructable years
later even after the grant is revoked. The result is persisted with its own evidence links and is
re-checked at verification.
006's `NO_EXPECTATION` outcome (006 FR-011) routes the issue away from the fix path, but a *positive*
claim from 006 grants nothing — 008 resolves the anchor itself.

**Rationale**: 006 is an earlier step in the same chain, so accepting its assertion that an anchor
exists is precisely the anchoring ADR 0002 forbids. Re-resolution costs one indexed query.

**Alternatives**: carrying the expectation reference forward from the diagnosis (a wrong diagnosis
then supplies its own anchor); resolving at test-writing time inside the change agent (the agent
chooses which expectation it is anchored on, which is choosing its own exam).

## R-05 · The system cannot author its own anchor

**Decision**: three independent mechanisms. The change component's credential has no write scope into
the knowledge module, so creating or adopting an `ExpectedBehavior` is not an available tool
(constitution Security Model). Adoption in 005 accepts only a human actor (005 FR-011), and
machine-generated provenance is ineligible regardless of state (005 FR-008, D-20, D-23). And a
continuous invariant (`check:anchor-precedence`) recomputes, for every accepted regression test,
that its expectation version was adopted by a human before the issue's first-seen time — SC-002 is a
running check, not a test.

**Rationale**: the single most valuable thing an over-eager implementation could do is write the
expectation it needs. One prohibition in a prompt is not a control. A missing credential, a typed
refusal and a standing invariant are three.

## R-06 · RED is a signature match, reusing the issue's normalisation ruleset

**Decision**: RED requires the regression test to fail on the pre-fix commit **and** the recorded
failure signature to match the issue's, normalised by the same `normalisation_ruleset` version the
issue's fingerprint used (001 R-01), the same comparison 007 uses for reproduction (007 FR-005). The
ruleset version is stored on the RED execution reference. A failure with any other signature, or no
failure, stops the loop and marks the diagnosis unconfirmed.

**Rationale**: "the test fails" is satisfied by a syntax error in the test file. The test must fail
*for the issue's reason*, and the only non-arbitrary definition of that reason already exists as the
fingerprint.

**Alternatives**: comparing assertion messages (assertion text is written by the agent under test —
the circle again); accepting any failure (admits compile errors and wrong-file failures as proof).

## R-07 · Transition guards read immutable execution records, so skipping is unsatisfiable

**Decision**: the fix loop is a workflow definition (012 FR-029) whose transitions are guarded by
references to 007 execution records, each with an immutable execution identifier and a recorded
commit SHA (007 FR-013). `GREEN_VERIFIED` requires a `RED_VERIFIED` execution for the same
`regression_test_id`, on the exact parent commit of the applied patch, with a matched signature.
Transitions are append-only in `fix_loop_transition` with a monotonic sequence and a unique
`(attempt_id, to_state)`. The change agent has no tool that writes an execution record.

**Rationale**: FR-009 forbids out-of-order transitions. A guard that checks a flag the same actor set
is a formality; a guard that checks a record produced by a different component, on a commit that
provably precedes the patch, is not something the loop can talk its way around.

**Alternatives**: a status field advanced by the orchestrator (a bug or a retry can advance it twice);
asserting order in review (the failure is silent and looks like success).

## R-08 · The pre-change baseline is captured per commit and cached

**Decision**: before the patch is applied, the full in-sandbox suite runs on the base commit and the
pass/fail set is stored as `test_baseline`, keyed by `(tenant, repository, commit_sha,
test_command_digest)` and reused across attempts on the same base. Blocking failures are the set
difference — passed before, fails after. An already-red baseline is recorded and reported as a
finding on the plan and in the pull request; it never silently licenses new failures.

**Rationale**: FR-012 needs a before-picture, and without caching every attempt on the same base pays
for the suite again, which is where the per-issue budget disappears. Reporting a red baseline matters
because "these three were already failing" is otherwise indistinguishable from "our patch broke
three tests".

## R-09 · Flakiness is measured by repetition, and a flaky anchor stops the attempt

**Decision**: candidate-proof tests run `repeat_count` times on the same commit (configuration, tuned
in stage 0). Any disagreement across repeats quarantines the test for that `(tenant, repository,
test_id)` with the commit and observed outcomes; a quarantined test counts as neither `PASS` nor
`FAIL` proof and is surfaced to the tenant as a finding. Quarantine expires after a configured window
and is re-measured rather than being permanent. **If the regression test itself is flaky, the attempt
stops** — an unstable anchor is not an anchor.

**Rationale**: FR-013 and SC-004. Historical result data is unavailable at onboarding, so repetition
on one commit is the only signal a new tenant has. Permanent quarantine would quietly shrink the
suite over a year until "tests pass" means very little.

**Alternatives**: historical flake detection (needs history nobody has yet); majority vote across
repeats (turns an unknown into a decision, which is exactly what this product must not do).

## R-10 · Masking detection is AST inspection, biased to false positives

**Decision**: `packages/code-intelligence/diff` classifies the patch at AST level and flags: a `catch`
introduced on a path in the issue's stack, a rejection swallowed (`.catch(() => …)`, empty catch,
`void`ed promise), a retry or backoff wrapper introduced around the failing call, a default or
fallback value introduced at the failure site, a type widened or an assertion loosened (`any`,
`unknown`, removed non-null assertion, narrowed test matcher), and any test weakened, skipped or
deleted. Detection is pattern-based, never a model, and deliberately over-flags.

**Rationale**: FR-014 and `failure-modes.md` §2. A false positive costs a human review; a false
negative ships a patch that removes the evidence path and makes the incident harder to find than
before Healer touched it. Regex over diff text misses a catch added three lines above the call and
flags it inside a string literal; the AST does not.

## R-11 · "Behavioural assertion independently satisfied" has a concrete definition

**Decision**: a masking candidate may proceed only when the anchored expectation carries a structured
constraint (005 FR-014) of a **positive** kind — `invariant`, `postcondition`, `exact_count`,
`value_equals`, `state_transition` — and the regression test asserts that constraint, and GREEN was
observed for it. Where the anchor's only constraint is an absence-of-error kind (`does_not_throw`,
`no_error_logged`), the masking candidate is **rejected outright**: the expectation cannot distinguish
a fix from a suppression, so nothing can. Where it does proceed, human approval is mandatory
regardless of autonomy grant (FR-015, 002 FR-015) and the flag appears in the pull request.

**Rationale**: "order is created exactly once" cannot be satisfied by swallowing an exception;
"no exception is thrown" is satisfied by exactly that. Encoding the distinction as a constraint-kind
allowlist makes it checkable instead of a judgement call at 3am.

**Alternatives**: asking a model whether the behaviour is still correct (the model that wrote the
suppression is well placed to explain why it is fine); a numeric masking score with a threshold (a
threshold on this is a threshold that gets crossed).

## R-12 · The verifier sees a projection, never the change agent's reasoning

**Decision**: the verifier's input is assembled by a deterministic projection function whose output
type contains: the anchor resolution, the expectation text and constraints, execution records with
signatures, the baseline diff, the change graph and classification, the masking findings, the patch,
and the raw evidence records for the issue. It does **not** contain the change agent's hypothesis
prose, rationale, tool transcript or confidence. The verifier's credential is read-only and cannot
reach the repository or the knowledge write path. Its prompt key and version are its own
(012 FR-038..041).

**Rationale**: `failure-modes.md` §3 — a reviewer asked "does this fix the reported root cause?"
inherits the premise, and the fastest way to inherit a premise is to be handed the reasoning that
produced it. A typed projection makes the leak a compile error rather than a prompt-assembly habit.

**Alternatives**: passing the full run context with an instruction to ignore the reasoning (an
instruction is not a boundary); a diff-only verifier (too little context to reject a diagnosis,
which is the verdict that matters most).

## R-13 · Independence rank is computed, and `APPROVE` has a floor

**Decision**: `independence_rank` is an ordered enum — `production_signal` (5),
`human_written_test` (4), `expectation_anchored_regression_test` (3), `second_model` (2),
`self_review` (1). Every verdict records the anchors available and the anchors actually used, and the
achieved rank is the maximum over the used set. `APPROVE` requires achieved rank ≥ 3 **and** at least
one anchor that existed before the chain started (the adopted expectation, or raw evidence). A
verdict whose only anchor is an artifact from earlier in the same chain is `INSUFFICIENT_EVIDENCE` by
construction (FR-018, SC-003).

**Rationale**: ADR 0002's ranking is not decoration; making it an enum with a floor is what turns it
into a gate. The verifier is a second model in v1, which the constitution calls weak — it is the last
line, and the floor states that in the schema.

## R-14 · `REJECT_DIAGNOSIS` discards the plan, not just the patch

**Decision**: `REJECT_DIAGNOSIS` routes to 006 for its one permitted re-diagnosis (006 FR-024, D-08),
and the current `ChangePlan` is closed as `invalidated` rather than extended. The `FixAttempt` is
preserved with the verdict. A second `REJECT_DIAGNOSIS` after re-diagnosis hands off to a human with
every attempt (FR-028, 002 FR-013). `REJECT_PATCH` keeps the anchor and the plan and permits a new
attempt within the cap.

**Rationale**: the plan's file scope and classification were derived from the diagnosis. Extending a
plan whose premise was just rejected carries the wrong blast radius into the next attempt, and policy
would be re-evaluating a scope nobody believes.

## R-15 · Writes are performed by a privileged applier, not by the agent

**Decision**: the change agent emits a structured `PatchProposal` — hunks with repository-relative
paths — and a regression test file. A separate privileged applier, which is not an agent and holds
the repository write credential, validates every path against the current plan version, refuses and
audits anything outside it, applies, and pushes to the Healer branch. The agent has no repository
write tool at all. Retrieved content — commit messages, PR bodies, issue text, log excerpts — enters
both agents as typed data fields, never as instruction text, and cannot reach a plan, a tool
selection or a policy input (FR-025).

**Rationale**: FR-005 is only enforceable if the enforcing component is the one holding the key.
Permissions are what tools grant, not what prompts say.

## R-16 · Repository mutations serialise through a lease, and nobody waits in a job

**Decision**: a `repo_mutation_lease` row, one per `(tenant, repository)`, is acquired before the
applier runs and released on attempt completion or expiry. A plan that cannot acquire it parks the
workflow in `AWAITING_REPO_LEASE` with a deadline (012 FR-025..027); the job returns immediately.
When the lease is obtained, an overlapping plan is re-evaluated against the other plan's current
state — open, merged or abandoned — and its impact analysis is re-run if the base commit moved.

**Rationale**: constitution VI plus FR-029. A Postgres advisory lock held inside a worker would be a
wait inside a job, which is the rule ADR 0003 exists to protect, and a lease row is also queryable
when someone asks why a fix has not started.

## R-17 · A moved base commit invalidates the impact graph

**Decision**: every impact analysis records `analysed_commit`. Before applying, before verification
and before opening the pull request, the current base is compared. A divergence marks the attempt
`stale` and requires impact analysis to be re-run before a rebase; a rebase without re-analysis is
refused.

**Rationale**: the blast radius, the classification and therefore the policy decision were computed
against a tree that no longer exists. A silent rebase turns an evaluated plan into an unevaluated
one while every record still says it was approved.

## R-18 · Pull request idempotency has two keys and a pre-flight search

**Decision**: `pull_request_record` is unique on `(tenant_id, issue_id, repository_id, target_branch)`.
Each create carries an idempotency key; a retry with the same key returns the original result. Before
creating, the adapter searches the repository for an existing open Healer pull request for the issue,
because a create can succeed at the provider while the response is lost. A later attempt updates the
existing request and appends to its history rather than opening a second one (FR-022, SC-007).

**Rationale**: providers time out after doing the work. A unique constraint alone leaves a real pull
request on the customer's repository that our database does not know about, and the second attempt
opens its twin.

## R-19 · No merge, at four layers

**Decision**: (1) the VCS port has no merge method — the capability is absent from the interface, so
calling it is a type error; (2) the change agent's repository credential is scoped to branch push and
pull request creation; (3) policy enforces the product-level ceiling that no tenant configuration can
raise (002 FR-008); (4) `gate-no-merge` in `make ci` fails the build if any call reaching a
merge-capable provider endpoint appears in the tree (012 FR-002, FR-016). SC-001 is verified in
production by reconciling repository merge events against Healer actor identities.

**Rationale**: D-12 and the constitution's L2 ceiling. Each layer alone has a plausible failure —
an interface gains a method, a token is over-scoped in a hurry, a rule is edited, a gate is skipped.
Reconciliation is the one that would catch the others.

## R-20 · Repeated approaches are fingerprinted, not remembered by prose

**Decision**: `approach_fingerprint` is a hash over the anchored expectation version, the sorted set
of touched symbols, the masking classes present, and the structural shape of the patch (node kinds
added and removed, not text). An attempt whose fingerprint matches a rejected attempt must carry a
`retry_reason` naming what changed; without one it is refused (FR-027). Every attempt is preserved
with its diff, executions, verdict and rejection reason, permanently (FR-026, SC-012).

**Rationale**: "do not repeat yourself" asked of a model produces a differently worded identical
patch. A structural hash catches the reformat; text comparison does not. And 011 needs rejected
attempts — a benchmark with only successes measures nothing.

## R-21 · Degraded language coverage widens, never narrows

**Decision**: where no code-intelligence adapter covers part of the repository, the graph is built
from what is derivable and the gap is recorded on the impact analysis and stated on the change plan
and in the pull request. A gap may only raise the classification tier or widen blast radius; it may
never lower either, and it blocks `APPROVE` at autonomy levels where the untouched surface is public
contract, migration or auth.

**Rationale**: constitution VII ships one adapter set in v1, and an incomplete graph looks exactly
like a small blast radius. The asymmetry is C-03's reasoning applied to coverage rather than to edge
provenance: widening costs review time, narrowing permits an action that should have been blocked.

## R-22 · An untested public surface is stated, not inferred as safe

**Decision**: when the graph shows a public contract, event contract or migration node inside the
blast radius with no covering test in the test-to-code map, a `coverage_gap` finding is attached to
the analysis and printed as its own section in the pull request. Passing tests elsewhere are never
evidence about that surface.

**Rationale**: the pull request is the artifact a human uses to decide. "All tests passed" over a
surface no test touches is the most misleading true sentence this feature could write.

## R-23 · Migrations are irreversible by default

**Decision**: a patch containing a migration is classified at the highest tier, marked
`reversibility = irreversible_by_default`, and requires human approval at every autonomy level. Its
`RollbackPlan` must name the revert mechanism *and* the data consequence; a migration with no stated
undo cannot be auto-approved (002 FR-009, 012 FR-049).

**Rationale**: reverting the code does not un-drop a column. The rollback plan is the only place the
distinction between "revert the deploy" and "restore from backup" gets written down before it matters.

## R-24 · End-to-end results are a callback, and "awaiting CI" is a distinct state

**Decision**: full-suite and end-to-end execution is delegated to the customer's CI (007 FR-021) as a
persisted waiting state plus an inbound callback (007 FR-022, 012 FR-030); results arrive as evidence
(007 FR-023). Until required results return, the fix's presented state is `awaiting_ci`, never
`verified`, and the pull request says so. A tenant may declare e2e optional per component; that
declaration is configuration, recorded on the record, and visible in the pull request.

**Rationale**: FR-020. The difference between "verified" and "we did not wait" is exactly the
difference a reviewer is relying on us not to blur.

## R-25 · `ChangeVerifiedInProduction` is **not** emitted in v1

**Decision**: this feature's terminal state is `PR_OPENED`. It publishes no production-verification
event, because at L2 Healer does not merge and does not deploy (D-12) — so it never observes the
production behaviour of its own change. `IssueResolved` in v1 comes only from 010 (a verified
reversible remediation) or from a human closing the issue.

The event name is reserved in [contracts/events.md](contracts/events.md) and documented as post-v1,
owned by the deployment-verification capability that L4 requires.

**Rationale**: the honest consequence of the L2 ceiling, and worth stating rather than leaving as an
event with no emitter. A feature that publishes "verified in production" while being structurally
unable to watch production would be the most dangerous kind of wrong — 009 releases held tickets on
exactly that event.

**Consequence**: 011's 30-day revert rate and production-verification metrics report **unavailable**
in v1, not zero, for changes produced by this feature. That is already how 011 handles a metric with
no data (011 FR-019).

## R-26 · Inbound merge facts arrive on their own callback, and reconciliation tolerates their absence

**Decision**: `POST /callbacks/merge-events` accepts a merge fact for a pull request this feature
opened — merged, closed without merging, or force-pushed over. It is a callback like CI results (ADR
0003), idempotent per delivery. `check:merge-reconcile` compares opened pull requests against received
merge facts and reports divergence.

Where a tenant does not configure the webhook, reconciliation reports **unknown**, not merged and not
unmerged. The no-merge guarantee does not depend on receiving these facts — it rests on the four
structural layers — so an absent webhook costs visibility, not safety.

**Rationale**: SC-001 and `check:merge-reconcile` need merge facts, and nothing carried them. Making
their absence explicit matters because a reconciliation check that silently reports success on no data
is worse than no check.

## R-27 · Per-component e2e requirement is a tenant declaration on the component

**Decision**: `component_verification_policy` — `component_id`, `e2e_required` (default **true**),
`declared_by`, `declared_at`. The `→ VERIFIED` guard reads it. Default true, because the safe default
is the stricter one, and a tenant opting out does so explicitly and visibly.

**Rationale**: FR-020's guard needed a field. Defaulting to false would mean a component nobody
configured skips e2e, which is the failure mode dressed as a default.

## R-28 · The loop entry reads both eligibility views itself

**Decision** (C-08): the `→ ANCHOR_PENDING` guard reads `diagnosis.fix_eligibility` (006) **and**
`reproduction.change_eligibility` (007) directly. 002 separately carries `codeProblemVerdict` and
`fixEligible` into `DecisionInput`, and that stays — two indexed reads against the one gate whose
failure means a patch on a Redis outage.

**Rationale**: only this makes 006 FR-002's "no path reaches 008 without the classifier" literally
true of this feature's own code. A single reader is a single place to forget, and reading the fact from
`DiagnosisCompleted` or `ReproductionCompleted` would make an at-least-once event payload the authority
over a view that cannot be written. Both events stay triggers.

**Alternatives**: trusting policy alone (008 would then have no refusal of its own, and a policy
misconfiguration is one edit); trusting the event payload (a stale or replayed payload opens the path).

## R-29 · No recipe means a synthetic equivalent, then a human

**Decision** (C-23, 007 R-06): where the only reproducing rung used an `anonymised` fixture there is no
recipe, so the regression test is built as a **synthetic equivalent** against the failing constraint
(`regression_test.fixture_source = synthetic_equivalent`). If it does not reproduce, the loop takes the
`NO_RECIPE` off-ramp to a human with the reproduction record and the constraint that could not be
satisfied. The extract is never requested back, regenerated or persisted.

**Rationale**: 007 already assigned 008 this obligation and 008 had nothing for it, so the case would
have surfaced as an unhandled state in the customer's network. The attempt is cheap because the failing
constraint is known. Allowing a recipe for an anonymised extract would reopen C-04 exactly where the
data is most sensitive, and proceeding on an unreproduced fixture would produce a RED nobody can trust.

**Alternatives**: routing to a human immediately (throws away the cases a generator satisfies, which is
most of them once the constraint is known); asking 007 to describe the extract (that description *is*
the extract, which is what C-04 forbids).

## R-30 · An expectation document in the plan is a hard refusal

**Decision**: a `ChangePlan` path or patch hunk path resolving to one of 005's expectation-defining
markdown sources is refused outright — recorded as a `masking_finding` with
`pattern = expectation_document_modified` whose `disposition` is pinned to `rejected` by a check
constraint, so no human-approval path reaches it (FR-014a).

**Rationale**: R-05's three mechanisms stop 008 *authoring* an expectation through 005's write path,
but nothing stopped it **editing the markdown that defines one** inside a fix PR. That PR would carry
its own verification anchor past a reviewer who believes they are approving a bug fix — the circle
ADR 0002 exists to prevent, arriving through the file system instead of the API. Treating it as a
weighable masking candidate would be wrong for the same reason: there is no anchor that can license
changing the anchor.

**Alternatives**: allowing it under mandatory human approval (the approval is on the fix, and the
expectation change rides along in the same diff); relying on 005's adoption gate (adoption is about a
new version's *grant*, and the document edit is what a later adoption would read).

## R-31 · A user journey is re-run as verification, separately from reproduction

**Decision**: a change touching a component that participates in a declared user flow (004's `flow`
nodes) has that flow's browser journey re-run as part of verification — regardless of which ladder
reproduced the issue, and regardless of whether a browser was involved in reproduction at all.

This is **not** the reproduction rung. Reproduction asks "can we make the original failure happen";
this asks "does the user-visible behaviour still hold". A server-side fix that makes an endpoint return
200 can still leave a spinner turning, and the regression test on the endpoint would never see it.

**Rationale**: it is the half of Playwright's role the original design had right. What was wrong was
the implication that Playwright is *only* verification — for a client-observable symptom it is also the
only instrument that can reproduce (007 R-22).

**Cost control**: only flows whose components the change touches, resolved through the `ImpactClosure`
(004). A change with no flow in its closure runs no journey, and that is the common case for worker and
background-job changes.

**Alternatives**: running every journey on every change (minutes per change, and the flakiness lands on
unrelated work); running none (the endpoint returns 200 and the product is still broken, which is
symptom masking with extra steps — failure-modes §2).

## R-32 · Where each part of the loop executes (ADR 0010)

**Decision**: the state machine, the guards, policy, the lease and every table in [data-model.md](data-model.md)
stay in the control plane. The change agent, the privileged applier (R-15), the masking analyser
(FR-014) and the verifier (FR-016) execute **in the runner**, each under its own `agent_directive` or
capability. What returns is `change_plan_proposal` for `PLAN_SUBMITTED`, `masking_candidate` for
`masking_finding`, `verification_verdict` for the verdict, `test_result` for RED and GREEN,
`pull_request_ref` for `PR_OPENED`, and `agent_run_report` for every model call (FR-016a). The
`PatchProposal` schema (T014) is validated in the runner, where the hunks exist; the control plane
never holds a hunk, which is already true of the data model — `fix_attempt` stores `patch_ref` and
`diff_digest`, never content.

The verifier's input projection (T074) is built in the runner, since it includes the patch; its
declared type and the absence test (T075) are unchanged. The verifier's directive and credential are
separate from the change agent's, so the two agents still cannot see each other's reasoning (R-12).

**Rationale**: the patch and every model call that reads source stay in the customer's network, and
the loop's guards keep reading the same structural facts they read before — they never needed the
content, only the shapes.

**Alternatives**: move the whole loop to the runner (policy and audit leave our infrastructure —
rejected in ADR 0010); keep the agents in the control plane with a bounded code excerpt (Healer
processes source in transit — rejected in ADR 0010).

## Unresolved

None.
