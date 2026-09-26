# Phase 0 Research: historical replay and the benchmark

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · The no-mutation guarantee is three structural facts, not a flag

**Decision**: a simulation run cannot mutate anything because of three independent, structural
properties.

1. **Capability passing.** Every mutating operation in the product — repository write (008 FR-025),
   remediation dispatch (010 FR-009), support answer publication (009 FR-016) — takes a capability
   object as an argument and cannot resolve one from a container, a module import or ambient
   configuration. A lint pattern forbids importing those infrastructure modules outside the
   privileged execution packages, using the pattern mechanism 012 FR-002 and FR-003 already provide.
   A simulation run is constructed with a capability bundle that contains none of them, so the
   mutating function cannot be reached — not "is not called".
2. **Credential minting.** The credential broker's principal kinds are a closed enum. A
   `simulation` principal has no representable grant for a production credential, a repository push
   token or a remediation credential, the same way 012's `fallback_scope` has one value: the
   dangerous configuration is absent from the type rather than defaulted away. This is what makes
   FR-005 true — there is no configuration surface to reject, because there is no field.
3. **Directive channel.** A run's runner session is opened as `evidence_and_sandbox_only`. The
   directive union it may emit contains `collection_plan`, `reproduction_directive` and
   `change_plan`; it does **not** contain `remediation_directive`
   (012 `contracts/runner-protocol.md`). A simulation cannot send a shape it cannot construct.

**Why `change_plan` is in the union (C-10).** A simulation must be able to apply a candidate patch and
run the tests, because `false_fix_rate` — the number the constitution defers L3 on — is defined as
"passed every gate and did not fix the problem" (R-08), and without executing the change there are no
gate results to pass and no reproduction to re-run. Excluding `change_plan` would leave that metric
permanently unmeasurable and every fix criterion permanently `not_applicable`, which is a benchmark
that cannot answer the question it exists for.

The scope is a **sandbox workspace and nothing else**: a checkout at the entry's commit, in the
execution plane, default-deny egress, no production credentials, destroyed after the run (FR-026,
007 FR-011..FR-014). **Repository write and pull-request creation stay excluded** — those take
`RepositoryWriteCapability`, which no simulation bundle holds (ADR 0008), so a run can change files in
a workspace that is about to be deleted and cannot change a single byte anybody will ever fetch.

This does not weaken the guarantee, because 007 already places sandbox execution outside ADR 0008's
scope: the ADR governs *irreversible* operations, and a workspace that holds no credentials and is
destroyed afterwards is reversible by deletion. The distinction the union encodes is therefore the right
one — not "may a simulation write?", but "may a simulation write anywhere that survives it?".

**Rationale**: the simulator's entire value is that it is safe to run before trusting anything. A
simulator whose safety is a configuration value will one day be run with the value wrong, and that
single event is the whole product. Three independent mechanisms means the property survives one of
them being wrong.

**Alternatives**: a `dryRun` flag checked at each mutation (one inverted condition from disaster,
and the condition lives in the code that writes to production); a separate read-only deployment
(diverges from the code being measured, so the benchmark stops measuring the product); a policy rule
denying mutations for simulation runs (policy is correct but it is one layer, and a policy bug is
exactly what the benchmark is meant to catch).

**Verification**: an attempt matrix e2e suite enumerates every mutating operation and asserts each
is unreachable from a run context, with the refusal recorded (SC-001). The suite runs under
`test-e2e`; no new gate is added, because the property is a runtime one and 012's gate set is a
contract.

## R-02 · One mechanism, two readings

**Decision**: the executor consumes an ordered set of run inputs and produces a `run_report` per
input. A single-issue simulation is a run over one input; a benchmark is a run over a dataset
version. Metrics are computed only where every input is a scored dataset entry; an input with no
ground truth — a currently open issue replayed read-only — yields a report and no score.

**Rationale**: FR-001 requires one mechanism, and the reason is not tidiness. The demo a customer
watches has to be the same code path the benchmark measures, or the demo is a different product.

**Alternatives**: a demo mode over a separate renderer (two code paths, and the demo drifts toward
flattering).

## R-03 · Reproducibility means identical scores, and a run earns the label

**Decision**: a run pins model identifier and version, prompt versions, dataset version, policy rule
version, retrieval snapshot, scoring version and adapter versions, sets temperature to zero and a
fixed seed where the provider supports one, and records the whole set as a digest. A run starts as
`reproducibility = unverified`. Repeating the identical digest and obtaining identical behavioural
scores promotes it to `reproducible`; any divergence marks it `non_reproducible` and names the
diverging component (FR-007). **A threshold may be derived only from a `reproducible` run.**

**Rationale**: FR-007 requires identical *behavioural scores*, not identical text, and that is the
achievable and the meaningful property — the model may word a diagnosis differently while every
criterion resolves the same way. Making reproducibility something a run earns rather than something
it asserts is what makes S0-3 defensible when someone asks why a threshold is what it is.

**Alternatives**: asserting reproducibility from the pinned configuration alone (pinning is
necessary, not sufficient — a provider can change a model behind a stable identifier); requiring
byte-identical output (fails constantly for reasons that do not matter, and the failures train
everyone to ignore it).

## R-04 · C-05 is a check constraint

**Decision**: the C-05 rule is enforced by the schema, in four parts.

- `dataset_version.synthetic_count` is **computed at publication** from the entries' origins and
  frozen. It is not a field anyone sets.
- `simulation_run.synthetic_scored_count` counts the synthetic entries the run actually scored —
  which is not the dataset's count, because unrunnable entries are excluded (FR-012).
- `threshold_derivation` **copies** the three run facts onto its own row —
  `run_synthetic_scored_count`, `run_completion_state`, `run_reproducibility` — and carries a local
  `CHECK` on each: `= 0`, `= 'complete'`, `= 'reproducible'`. The copies are held equal to the run's
  own values by a **composite foreign key** onto a unique key
  `simulation_run (id, synthetic_scored_count, completion_state, reproducibility)`. A derivation row
  citing a run that touched synthetic material cannot be inserted, and the run cannot later be
  re-marked `partial` under a derivation that still cites it.
- `threshold_derivation` also records `real_denominator`, with `CHECK (real_denominator >= 20)`. When
  the real cohort is below it, **no derivation row exists**, and the L2 ceiling stands by default —
  which is the correct outcome, not a failure state.

**Why the copies, corrected.** This entry originally put the four constraints on
`threshold_derivation` while referencing columns of `simulation_run`. A Postgres `CHECK` cannot span
tables, so those constraints would not have existed — C-05's entire enforcement mechanism would have
been a comment in a design document, and the first insert from a script would have carried whatever it
liked. Denormalising the three facts is what makes them checkable locally; the composite foreign key is
what stops the denormalisation from being a place for the values to drift. `min_real_yield` is written
as the literal `20` rather than as a symbol, because a `CHECK` cannot call a function that reads
configuration — which is exactly the property R-15 wants.

**Rationale**: C-05 exists because synthetic incidents are easier than life, and a threshold
inflated by them permits more autonomy than was earned. A documented rule is followed until the
quarter when the real yield is disappointing and the combined number looks fine. The constraint is
the only version of this rule that holds under that pressure.

The denominator, not the dataset size, is the subject of the minimum: a 25-entry dataset with 8
unrunnable entries yields 17, and SC-011's stage-0 exit size would otherwise be satisfied by a
dataset that never produced 20 scored results.

**Alternatives**: a validation in the derivation command (bypassed by the first migration or
script); a report-time warning (a warning next to a number is read as the number).

## R-05 · Cohorts exist; a combined headline does not

**Decision**: `run_metric` rows are keyed by `(run, metric, cohort)` with cohort in
`real | synthetic`. There is **no `combined` cohort and no column for an overall figure**. A caller
asking for a metric must name a cohort. Where a report shows both, it shows two labelled numbers and
the synthetic share.

**Rationale**: "never combined into one headline figure" (C-05) is a property about what can be
read, so the right enforcement is that the combined number has nowhere to live. Every convention
that a figure must be labelled survives until someone builds a dashboard from the schema.

## R-06 · The scorer is not given the human patch

**Decision**: the scoring function receives a `GroundTruth` object containing the recorded
historical outcome, the pre-existing test suite reference, the reproduction result and the recorded
recurrence observation. The fix commit SHA is stored on the dataset entry for provenance and for a
human reading the case; it is **not** a field of the scoring input, and the diff is never fetched by
the scorer. SC-005's automated check inspects the scoring input type, not the scoring body.

**Rationale**: FR-014 forbids similarity scoring. A rule forbidding it is enforceable only by
review, and a review misses it once. A scorer that was never handed the patch cannot compute
similarity to it, however careless the next change is. This also keeps the incentive right: a fix
better than the engineer's original must score as a success, or the benchmark trains the product
toward copying workarounds.

**Alternatives**: a lint rule against importing a diff library in the scoring package (a denylist,
and there are many ways to compare two strings).

## R-07 · Criteria are tri-state, and inapplicability is stated

**Decision**: each criterion resolves to `pass`, `fail` or `not_applicable`, and records the anchor
it used. `not_applicable` is used where the criterion genuinely cannot be observed:

| Criterion | Anchor | When it is `not_applicable` |
|---|---|---|
| Regression test passes | the test produced in the run, executed in the sandbox (007) | the run never reached a change plan |
| Original failure no longer reproduces | the reproduction that failed before the change (007 FR-004) | the entry was never reproducible |
| Pre-existing suite still passes | the suite at the entry's commit, human-written (II) | no suite exists at that commit |
| No unintended behavioural change | 008's deterministic impact analysis (008 FR-001) | repo state unrecoverable |
| Incident did not recur | production observation of a **merged** change | always, for a replayed historical entry — nothing was merged, so nothing can recur |

A verdict aggregates only applicable criteria and names the inapplicable ones. A score with fewer
than two applicable criteria is `unscored` rather than a pass.

**Rationale**: the fifth criterion of S0-2 cannot be evaluated by replaying history — we did not
deploy anything, so nothing could recur. Recording it as a pass would inflate every aggregate that
includes it, silently, and the inflation would land in the thresholds. Saying "not observable here"
is both honest and cheap.

**Alternatives**: dropping the criterion (loses it for live tenants, where it is the most valuable
one); treating it as a pass (fabricates the strongest signal in the set).

## R-08 · False fix, defined so it can be counted

**Decision**: a false fix is an attempt that obtained every gate the run applies — RED, GREEN, the
pre-existing suite, and an `APPROVE` verdict from the verifier (008 FR-009, FR-017) — and failed at
least one applicable behavioural criterion. Each is retained with the gates it passed, the evidence
it used, the model and the prompt version (FR-017). SC-006 seeds known false fixes and asserts the
reported count matches exactly.

**Rationale**: "passed every gate and did not fix it" has to become a predicate over recorded facts
before it can be a rate, and it is the number the constitution defers L3 on. Defining it as
"verifier approved but behaviour says otherwise" is what makes it a measurement of the gates rather
than of the model.

## R-09 · 30-day revert rate is tri-state and reconciled, never zero

**Decision**: `run_metric` carries `availability` in
`available | insufficient_observation | not_applicable` alongside a nullable value. The revert rate
is `insufficient_observation` until there exists at least one merged Healer-produced change whose
thirty-day window has closed for that tenant, and the reason is stated. Observation is per change:
a scheduled reconciliation job reads merged changes whose window closed, records a
`revert_observation`, attributes it to the producing run, and recomputes the metric. No job waits
for thirty days (012 FR-025).

**Rationale**: a revert rate rendered as 0% because nothing has been observed is the most flattering
possible lie, and it would be read as evidence for L3. An explicit "not yet measurable, because no
tenant has run at L2 long enough" is the honest statement and it is also the sales-safe one.

**Alternatives**: null rendered as zero by the client (the failure mode this decision exists to
prevent); omitting the metric until it has data (its absence is then read as an oversight rather
than as a fact).

## R-10 · Import reuses the closed boundary schema instead of scanning for secrets

**Decision**: a dataset entry is imported as the closed evidence shapes of the runner protocol
(012 FR-022, 012 R-04) — error signature, trace shape, metric delta, deploy ref, commit ref, test
result, file path, tool output summary, collection gap — plus a repository reference and commit SHA.
Free-form text fields are not accepted, so there is nothing to scan. An entry containing a field the
schema does not declare is rejected, not cleaned (FR-025).

Repo state is referenced, never stored: either a repository plus commit SHA resolved in the
execution plane at run time, or a customer-produced bundle whose digest is recorded and whose
contents stay in their plane. Healer retains no customer source, consistent with C-04.

**Rationale**: redaction on receipt is the wrong side of the boundary, and a denylist of secret
patterns is never complete. Reusing the schema that already exists for this exact problem costs
nothing and is the artifact a security review already reads.

**Alternatives**: a regex secret scanner on import (a denylist, and a false negative is permanent
because the entry is then stored); accepting free-form incident text (defeats the boundary the
hybrid deployment was built for).

## R-11 · What a prospect with nothing connected actually runs

**Decision**: the zero-integration path (SC-008) is the runner image (C-01), run by the prospect on
a machine that can see their repository and their incident export. It connects outbound only, needs
no inbound firewall rule, and is granted no credential by us. Replay executes the sandbox there;
only the closed evidence shapes and the structured report cross to the control plane.

**Rationale**: SC-008 says "no integration connected and no credential granted", and that is
achievable only if the execution stays on their side. It also means the sales demo and the product
are the same artifact — the prospect's first experience of the runner is the one they would deploy.

**Alternatives**: uploading a source archive to us (creates customer source at rest, a DPA clause
and a different code path from the product); a hosted demo on our own data (demonstrates nothing
about their system).

## R-12 · Partial runs check-point per entry and cannot back a threshold

**Decision**: each entry's report and score are committed as they complete. Exceeding the run budget
suspends the run in `partial` with the consumed budget recorded (002 FR-011), resumable from the
first unscored entry. A `partial` run is readable and comparable but is refused by the threshold
derivation constraint (R-04, FR-023).

**Rationale**: a dataset run costs real model spend, and a run that loses everything at the budget
limit will simply never be run again. Allowing a partial run to back a threshold would make budget
exhaustion a way to get a favourable denominator.

## R-13 · Prompts resolve by version, so the unversioned-edit case cannot arise for new runs

**Decision**: the harness resolves prompts by `prompt_version_id` only (012 FR-038, 012 FR-039, 012
R-07) and refuses to start when any agent in the run configuration is set to resolve by path or by
key alone. The `unreproducible` marking for prompt drift therefore applies to runs recorded before
this rule, not to new ones.

**Rationale**: 012 already makes prompts immutable and content-addressed; the remaining hole is a
runtime that reads the working tree. Closing it at run start is cheaper than detecting it
afterwards, and the benchmark is the one consumer that cannot tolerate a moving target (D-07).

## R-14 · Evaluation routing is designated *within* the tenant's provider scope

**Decision**: the evaluation-designated routing adapter (D-10) is registered only inside
`packages/domain/evaluation/**`, enforced by a boundary pattern, and the production path cannot
import it (FR-009). It resolves per tenant like every other model call: for a Healer-provided tenant
it routes through the evaluation router; **for a tenant using their own provider it resolves to that
tenant's provider** and the run records which routing was used. Runs are comparable only within the
same recorded routing, which is part of the configuration digest.

**Rationale**: D-10 exists so that routing *variance* does not contaminate the benchmark, and that
purpose is served by pinning an exact model at an exact provider and recording it. Reading D-10 as
"always route evaluation through the shared router" would send a customer-supplied-provider tenant's
source to the Healer-managed provider, breaching 012 FR-046 and 012 SC-016 and the contract that made
that tenant adoptable — discovered, as these things are, during an audit. See the contradiction note
below.

**Alternatives**: routing all evaluation through the shared router (breaches 012 FR-046); refusing
to benchmark BYO tenants (the tenants most likely to demand evidence before raising autonomy are
exactly the ones who insisted on their own provider).

## Contradiction found

**011 FR-009 with D-10, against 012 FR-046 and 012 SC-016.** FR-009 requires the evaluation path to
use the evaluation-designated routing; 012 FR-046 forbids any request from a customer-supplied-
provider tenant reaching the Healer-managed provider, and SC-016 measures it at zero. Taken
literally together, a benchmark run for a BYO tenant is impossible without breaching one of them.

Resolved as R-14: "evaluation-designated routing" means routing chosen for evaluation *within the
tenant's declared provider scope*, not a specific shared vendor. No spec text needs to change —
FR-009 and D-10 are satisfied by recording the routing and pinning the model — but the reading is
recorded here because the naive implementation breaks 012 FR-046 silently and would be found by an
audit rather than by a test. 012 SC-016's continuous check is what catches a regression.

## R-15 · `min_real_yield` is a product constant, not tenant configuration

**Decision**: the minimum scored-real denominator for deriving an autonomy-governing threshold is a
constant in code — 20, matching SC-011 — and is **not** per-tenant configurable and not raisable or
lowerable through configuration. Changing it is a spec change with a constitution amendment, like the
autonomy ceiling.

**How it is established**, mirroring 002's `ACTION_CEILING`: a constant in
`packages/domain/evaluation/domain/threshold.ts`, the **literal `20` written into the migration** as
`CHECK (real_denominator >= 20)` — a `CHECK` cannot call a function that reads configuration, which is
the property wanted rather than a limitation worked around — and a test asserting the two agree and
that **no configuration path, request body or environment variable can lower either**. Raising it is a
spec change with a constitution amendment, like the autonomy ceiling. FR-021a states it; the data model
and [contracts/scoring.md](contracts/scoring.md) carry the value.

**Rationale**: C-05 exists to stop a threshold resting on too little real evidence. A configurable
minimum is a minimum that gets lowered by whoever wants the threshold, under exactly the pressure the
constant exists to resist. Same argument as 002's `ACTION_CEILING`: the dangerous state should not be
representable. Until this entry named a mechanism, the constraint referenced a symbol with no SQL
definition — a rule that reads as enforced and is not.

## R-16 · Diagnosis accuracy is human-adjudicated ground truth, recorded once

**Decision**: `diagnosis_accuracy` compares the produced diagnosis against a **human adjudication
recorded on the dataset entry** — an engineer decided, once, what the root cause was, and that
judgement is part of the golden dataset. Scoring is a structured match against that recorded value,
not an evaluation of prose.

There is no judge model.

**Rationale**: a model scoring a model's diagnosis is the correlated-review failure (failure-modes §3)
with the added problem that the benchmark would then measure agreement between two models rather than
correctness. Recording the adjudication once per entry costs an engineer minutes and makes every future
run comparable against the same ground truth.

**Consequence**: adding an entry to the golden dataset requires human adjudication, which bounds how
fast the dataset grows. Accepted — a dataset that grows without adjudication measures nothing.

## R-17 · Revert attribution needs a producing-run reference written by 008

**Decision**: 008 records `producing_run_id` on the change it opens, and a production revert or
re-fix resolves back through it. This feature reads the reference; it does not infer attribution from
timing or authorship.

**Rationale**: FR-018's 30-day revert rate is meaningless without knowing which run produced the
reverted change. Inferring it from commit timing would attribute a human's revert of a human's change
to whichever run happened to be nearby.

**Cross-spec**: recorded as a requirement on 008; without it this metric reports unavailable.

## R-18 · The threshold in effect is the latest non-superseded derivation, and 002 is its consumer

**Decision**: policy (002) reads the latest `threshold_derivation` row that is not superseded, for the
threshold key it needs. `superseded_by_id` gives history; the absence of a successor gives current.
Two non-superseded rows for one key is an invariant violation, checked continuously.

**Rationale**: FR-022 requires surfacing a conflict, and a conflict is only definable once "in effect"
is defined. Naming 002 as the consumer also means a threshold change is visible in policy decisions
rather than sitting in a table nobody reads.

## R-19 · The benchmark set is sealed, and the split lives on the entry

**Decision**: every `golden_issue` declares `split ∈ dev · benchmark`, mandatory, no default, never
updated. The first twenty adjudicated **real** incidents go to `benchmark` and stay there; prompt, agent
and policy iteration uses `dev` entries and synthetic material. A run records `split_scope`, computed
from the entries it actually scored, and only a `benchmark` run can back a threshold (FR-021b).

**Rationale**: the four thresholds gate autonomy, and they were being derived from the same incidents the
prompts were tuned against. That is train-on-test: the false-fix rate comes back optimistic by exactly the
amount of tuning, and the consequence of an optimistic number here is a higher autonomy level — an agent
writing to a customer's repository on the strength of a measurement that flattered itself.

**Why the split lives on the entry, not on `dataset_entry` membership**: whether an incident has ever been
available to tuning is a property of the incident. Membership-level split would let the same incident be
published `dev` in version 3 and `benchmark` in version 4 — laundering a tuned-on entry into the set that
justifies raising autonomy, which is the failure the split exists to prevent.

**Alternatives**:

- *A conventional random split of the dataset.* Halving twenty real incidents destroys
  `CHECK (real_denominator >= 20)` and would push stage-0 S0-1 from twenty recoverable incidents to about
  forty. Sealing the first twenty as `benchmark` leaves the S0-1 exit criterion exactly as it stands.
- *A governance rule — "do not tune on the benchmark set" — with no mechanism.* Prose. The rest of this
  repository prefers a shape that cannot express the unsafe state (`docs/patterns.md`).
- *Forbidding tuning runs against benchmark entries outright.* Tempting and wrong: an engineer
  legitimately needs to look at a failing benchmark case to understand it. What matters is that the
  exposure is **recorded**, and it is: every run carries `split_filter` in its configuration digest and
  `split_scope` in its result, so tuning against sealed material is visible in the audit rather than
  prevented by trust. The threshold path is what closes, not the human's eyes.

**Consequence**: `split_scope` joins the composite foreign key. The unique tuple on `simulation_run`
becomes `(id, synthetic_scored_count, completion_state, reproducibility, split_scope)`, so a run cannot be
re-marked under a threshold that still cites it.

## R-20 · A derivation is exported as an artifact so that a check without a database can resolve it

**Decision**: publishing a derivation also writes a self-contained artifact — threshold key, value, run
id, dataset version, metric, scored real denominator, the four run facts — committed to the repository
under `docs/derivations/`. `threshold_derivation.artifact_digest` records its digest. The row is the
authority; the artifact is provenance.

**Rationale**: 002's `ACTION_CEILING` is a pure function in code, and raising a level for an action class
is a source change. `gate-ceiling` validates grant rows against that function, so it catches data that
exceeds the ceiling — and nothing catches an edit to the ceiling itself. The gate needs to resolve a
derivation at continuous-integration time, where there is no control-plane database.

**Why not read the database from CI**: it would give the build pipeline credentials to the control plane
to check a compliance fact, and a gate that cannot reach the database would then fail on an outage rather
than on a violation — noise that gets the gate disabled.

**Why the artifact does not become the authority**: a file can be hand-written. The row cannot, because of
the composite foreign key and the checks around it. Continuous reconciliation — a committed artifact with
no row, or a digest that disagrees — is the second mechanism, the same shape as 002's reconciliation of
`policy_decision` against `audit_entry`. Enforce twice where one mechanism is bypassable.

## Unresolved

None.
