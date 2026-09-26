# Phase 0 Research: reproduction engine and isolated execution

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · The rung vocabulary is frozen here, as ordered reference data

**Decision**: six rungs, fixed order, defined once in
[contracts/ladder.md](contracts/ladder.md) and stored as reference rows:

```text
1  unit             deterministic, in-process             seconds
2  request          deterministic, needs app boot         tens of seconds
3  data             needs a specific input shape          needs fixture construction
4  concurrency      needs interleaving                    flaky by nature, repeats required
5  load             needs a load harness                  expensive
6  external_state   needs a state we do not control       usually impossible
```

006 imports this vocabulary and does not restate it. Adding a rung is a data change plus a contract
version bump, visible to both specs.

**Rationale**: this is the interface between 006's directive and this engine. Two enum definitions
in two specs drift on the first change, and the drift surfaces as a directive naming a rung the
engine does not have — at run time, in the customer's network. The order is a column rather than
code because the climb rule is "ascending `rung_order`, stop at the first that reproduces", which is
one comparison and needs no branch per rung.

**Alternatives**: rungs as a cost-estimate function chosen per issue (makes SC-002 — "no rung above
the reproducing rung was attempted" — unverifiable, because "above" stops being a total order).

## R-02 · A `FAIL` is signature equality under the issue's own ruleset version

**Decision**: the observed failure is normalised with the **same** `normalisation_ruleset` version
the issue recorded (001 R-01, `issue.ruleset_version`). `FAIL` requires:

- identical normalised `exceptionType`
- identical normalised `errorCode`
- the issue's normalised frame sequence is a **contiguous suffix** of the observed frame sequence
- identical `endpointTemplate` where the issue carries one

Anything else is `INCONCLUSIVE` with reason `signature_mismatch`, plus a `separate_defect_finding`
row surfaced to the human — it may be a second bug (spec edge case).

**Rationale**: FR-005 and the whole value of this feature. Reusing 001's normalisation rather than
writing a matcher means the function that decided these signals were one issue is the function that
decides whether this is that issue — there is no second opinion to disagree with the first. Pinning
the *version* matters because a ruleset published last week would otherwise silently change what
counts as a reproduction of a month-old issue.

The suffix rule is the one deliberate relaxation: a sandbox stack has a test-harness prefix that
production does not, so the observed sequence is legitimately longer at the outer end. Requiring the
issue's frames to be a contiguous suffix keeps the innermost frame — where the failure actually
happened — identical, which is the part that must not be relaxed.

**Alternatives**: similarity scoring over frames (a threshold that, tuned to reduce false
`INCONCLUSIVE`, immediately starts counting different failures as reproductions — and the error is
silent); exit code plus test name (says nothing about *which* failure occurred).

## R-03 · Rung skips are recorded, and a skip is not a climb

**Decision**: each rung is attempted, skipped or errored. A skip carries a reason from a closed set
— `preconditions_unavailable`, `above_max_rung`, `no_entry_point`, `no_harness`,
`grant_absent`, `budget_exhausted` — and the climb continues to the next rung. A rung that errored
is recorded as `error` and does not count as `not_reproduced`.

**Rationale**: FR-003. The difference between "we tried the concurrency rung and it did not
reproduce" and "we never had a concurrency entry point" is the difference between evidence and a
gap, and the human reading an `INCONCLUSIVE` handoff needs to know which. Collapsing both into
"not reproduced" makes the handoff a list of things that did not happen for unstated reasons.

## R-04 · Repeats are a per-rung-class policy, and the rate is carried, not judged

**Decision**: rungs 1–2 run once, plus one confirming repeat when the first result is `FAIL`. Rungs
4–5 always run `n` repeats (configuration, tuned on the stage-0 audit). The attempt records
`observed_runs` and `reproduced_runs`; `intermittent = reproduced_runs < observed_runs`, with
`observed_rate = reproduced_runs / observed_runs`.

The flag and the rate travel to 008 on the attempt record. This feature does **not** decide whether
an intermittent reproduction is good enough to prove a fix — 008 FR-013 already quarantines a test
whose result varies across repeats on the same commit, and 008 FR-011 owns GREEN.

**Rationale**: FR-007. Three-in-ten and ten-in-ten are different facts and the difference changes
what a fix can claim, so the number has to survive the handoff. Deciding here what the number
*means* would put the same rule in two places, and the two would eventually disagree about a fix
that passed one and not the other.

**Alternatives**: a fixed repeat count for every rung (wasteful on deterministic rungs, and still
too few on a race that reproduces once in fifty).

## R-05 · `INCONCLUSIVE` is one result with a closed reason set

**Decision**: the three-value result of FR-004 stays. Every `INCONCLUSIVE` carries
`inconclusive_reason` from a closed set:

```text
no_rung_reproduced · signature_mismatch · build_failure · environment_failure
timeout · unparseable_output · no_test_command · commit_unavailable
budget_exhausted · capability_refused
```

All ten route to a human (FR-006) and none may be recorded as `PASS` (FR-016, FR-019, SC-006).

**Rationale**: "inconclusive" alone is not actionable, and each of these has a different next move —
`commit_unavailable` needs the branch restored, `no_test_command` needs tenant configuration
(FR-020), `signature_mismatch` may be a second defect, `capability_refused` is a runner upgrade
(C-02). A closed set is also what makes SC-006 reconcilable and what lets the eval harness report
*why* the reproducible share is what it is, which is the number that sizes the product (SC-008,
stage 0 S0-1).

**Alternatives**: separate top-level outcomes per reason (every consumer would have to handle ten
cases that all mean "not proven, route to a human"); free-text reason (unmeasurable).

## R-06 · No fixture store, and what reaches 008 is a recipe

**Decision** (C-04, decided — not reopened here, only implemented):

- `reproduction_fixture` records rung, construction mode, a content digest, the scan result, the
  grant reference and lifecycle timestamps. **There is no contents column.**
- The fixture exists only on the workspace tmpfs and dies with the run container (R-07).
- Where 008 needs fixture data for a regression test, 007 hands it the **recipe**: for
  `request_shape`, the field presence/type/bound descriptor; for `synthetic`, the generator
  parameters and seed. 008 materialises it and commits it to the customer's repository with the
  test, where their test data already lives, under their retention and their review.

**The sharp consequence**: an `anonymised` fixture has no recipe — an anonymised extract is derived
from a production record, so describing it precisely enough to regenerate it would be a way of
carrying it. When the only rung that reproduced required an anonymised extract, 008 **attempts a
synthetic equivalent** and routes to a human when that does not reproduce — its `NO_RECIPE` off-ramp
(C-23, 008 FR-011a). This is stated here because it is the one place C-04 costs something real, and
discovering it during 008's implementation would be worse.

**Rationale**: the fixture has to live in the customer's repository anyway for their CI to run the
test. A second copy in Healer adds derived customer data at rest and a DPA clause, and buys nothing.
Removing the column rather than emptying it means the decision cannot erode.

**Alternatives**: retaining fixtures with a short TTL (a retention policy is a promise; an absent
column is a property); storing only a hash and re-deriving (re-deriving an anonymised extract
requires the source record again, which is the thing being avoided).

## R-07 · The workspace is destroyed by container exit, not by cleanup code

**Decision**: the workspace is a tmpfs mount inside the run container, and the dependency cache is
mounted read-only from a per-tenant volume. Container exit destroys the workspace on every path —
success, test failure, timeout kill, crash, node failure. A reconciliation job verifies that no
workspace outlives its run's grace period (SC-005).

**Rationale**: FR-014 says "including on failure and on timeout", and cleanup code is exactly the
code that does not run on those paths. Making destruction a property of the runtime rather than a
step means there is no path to forget, and the reconciliation job exists to catch the runtime being
wrong rather than the application.

**Alternatives**: a deletion step in a `finally` block (does not survive SIGKILL, an OOM kill, or a
node eviction — the three cases most likely to leave a fixture behind).

## R-08 · Default-deny egress is an absent route, not a filter

**Decision**: two containers per run.

```text
prefetch container    network namespace with egress to the package registry allowlist only,
                      built into the image at build time (FR-011); writes the dependency cache
run container         network namespace with NO default route and no DNS; the cache is mounted
                      read-only; connect() fails at the syscall
```

Denials are recorded where a denial can happen: the prefetch proxy logs non-allowlisted destinations
as `egress_denial` rows, `phase = prefetch`. The run container produces no denial rows — there is no
route and `connect()` is not intercepted (R-19) — so what is recorded for it is the **posture**: route
table empty, resolver absent, allowlist digest, written to `execution_run.egress_posture`. Both cross
the boundary as a `tool_output_summary` evidence shape.

**Rationale**: `security-posture.md` names this as mattering more in practice than container escape,
and FR-011 requires the allowlist to exist **only** at image-build time for the prefetch phase — the
run container has no egress configuration at all, so there is no run-time route, not even a
default-deny one to widen by accident.
A single container with an allowlist is one CIDR from being wrong, and being wrong is silent — the
test suite simply succeeds at reaching the internet. A namespace with no route cannot be
misconfigured into permitting egress; it can only fail to start.

**Alternatives**: one container with iptables rules (a denylist by another name, and test suites
routinely spawn processes that inherit the namespace); an egress proxy with an allowlist for the run
container (works, but the allowlist then has to exist at test-run time, which FR-011 pushes back to
build time precisely because run-time configuration is the mutable surface).

## R-09 · Credentials are scanned before and after, and the cache is per tenant

**Decision**: before the run, the environment, mounted paths and the checkout are scanned against
the tenant's secret-reference fingerprints and generic secret patterns; a hit aborts the run. After
the run, the same scan runs over what the workspace produced, before anything crosses the boundary.
The dependency cache volume is per tenant even where the contents would be byte-identical.

**Rationale**: FR-012 requires an automatic check on every run, and the pre-run check catches a
misconfigured mount while the post-run check catches a test that wrote one. Sharing a cache across
tenants creates a writable channel between them dressed as an optimisation — a poisoned package in
tenant A's cache executing in tenant B's run is the isolation failure that ends the company, and the
saving is disk.

## R-10 · Adapters request a machine-readable report; they never parse prose

**Decision**: a test-runner adapter declares a detection predicate (files present), a command
template, and a **machine-readable report flag** it injects (JUnit XML or the runner's JSON
reporter) plus the path the report lands at. Discovery, invocation and parsing are three separately
recorded steps. If no adapter matches, the tenant-declared command is used (FR-020) — and it must
also declare a report path. An adapter that cannot obtain a machine-readable report declares the
repository `unsupported`.

Outcomes are distinguished explicitly: `report_present` false with a non-zero exit is
`inconclusive_reason = unparseable_output`, which is not the same record as parsed failing tests
(FR-020 edge case).

**Rationale**: FR-019 and the reason it exists — an unparseable output that degrades to "looks fine"
is a false `PASS`, and a false `PASS` opens the change path on a defect that was never reproduced.
Parsing human stdout works for the three runners we test and fails on the fourth, silently, in the
unsafe direction. Requiring a structured report moves the failure to discovery time, where it is
loud and produces an actionable `INCONCLUSIVE`.

**Alternatives**: regex parsers per runner (the classic version of this component, and the reason
the spec calls it "an entire component, not a line item"); inferring from exit code alone (cannot
distinguish a failing test from a failing build, which FR-017 requires).

## R-11 · CI delegation is a persisted state plus a callback

**Decision**: `ci_delegation` holds the requested scope, the external run identifier, the deadline
and the receipts. The wait is a `workflow_callback` of kind `ci_result` (012 data model) with a
token hash and an expiry; the workflow run's `deadline_at` resolves a callback that never arrives,
via the scheduled tick. A duplicate callback increments `received_count` and changes nothing else.
CI results are ingested as `test_result` evidence correlated to the requesting execution (FR-023).

**Rationale**: ADR 0003 and constitution VI. D-16 sends the full suite and e2e to the customer's CI
because that is where the credentials, services and data are — which also removes most of the
secrets problem from the sandbox. The callback shape is what keeps BullMQ sufficient; a job polling
a twenty-minute pipeline is how this design quietly becomes a worse Temporal.

## R-12 · Capacity queuing is a state, not a blocked worker

**Decision**: a run that cannot start because the tenant is at the runner's declared
`maxConcurrentRuns` (012 runner protocol) is persisted as `execution_run.state = queued` with a
bounded wait deadline. Queue depth per tenant is a metric. No worker job holds the position.

**Rationale**: the spec's edge case, plus 012 FR-025. A queued run occupying a worker converts a
capacity limit into a throughput collapse, and the wait is then invisible to everything except the
job's wall-clock alert.

## R-13 · A retry is a new execution, and results never merge

**Decision**: a run retried after an infrastructure failure receives a new `execution_run` id.
`superseded_by` links the old record to the new one for the human; no query aggregates across
execution identifiers, and `test_result` rows are keyed by execution id.

**Rationale**: FR-013. Merging results across attempts produces a composite run that never happened
— the classic version being "it passed on the retry, so it passes", which is precisely the
intermittency that R-04 exists to measure rather than launder.

## R-14 · The environment is recorded well enough to explain a divergent re-run

**Decision**: every run records the resolved commit sha, the base image digest, the lockfile digest
and the resolved dependency version list. Where the repository has no lockfile, the prefetch phase
generates one and records its digest.

**Rationale**: FR-015 and the spec's floating-dependency edge case. The goal is not to guarantee
reproducibility — with floating versions that is not achievable — but to make a later re-run that
behaves differently *explainable*. "The same commit, a different transitive version" is an answer;
"it worked yesterday" is not.

## R-15 · Two tools, no shell

**Decision**: agents reach the sandbox through exactly two declared, schema-validated tools:
`runReproduction(directive)` and `runTests(selector)`. Both are permission-checked and audited per
invocation (012 FR-033). The sandbox has no credential, socket or route to the control plane other
than the structured result contract (012 FR-022).

**Rationale**: FR-028 and the constitution's security model. A shell tool is a generic capability
that makes the audit record useless — "ran a command" — and it makes every prompt-injection path
(`failure-modes.md` §8) a direct route to arbitrary execution over the customer's source tree.

**Not a capability-passing operation** (ADR 0008): sandbox execution is deliberately outside that
pattern's scope. Its effects are bounded by the limits and destroyed with the workspace, so it is
reversible by construction; the irreversible operation downstream is the repository write, which is
008's and holds `RepositoryWriteCapability`. Applying capability passing here would add threading to
every call in the climb and, by the ADR's own reasoning, turn the pattern into noise that hides the
cases that matter. The sandbox holds no capability of any kind — which is the stronger statement.

## R-16 · The change path is closed by a view, the same way 006 closes the patch path

**Decision**: `reproduction.change_eligibility` is a SQL view **left-joined from `issue.issue`**, so
every issue has a row: `eligible = coalesce(latest attempt result = 'FAIL', false)` plus `blocked_by`,
a closed-set array carrying `no_attempt` when no attempt exists, `not_reproduced` for a `PASS`, or the
`inconclusive_reason`. Joining from the attempt table instead would mean "no reproduction yet" has no
row to read and no reason to report, which is the state tasks and quickstart both need to see as
`no_attempt`. The array shape matches 006's `fix_eligibility.blocked_by`, so 008 and policy read one
shape from both views. 008 and the policy engine read it; 002 FR-005 turns an absent rule into `DENY`,
so "no reproduction yet" and "reproduction said `PASS`" behave identically.

**Rationale**: FR-001 requires that no execution path reach 008 without a `FAIL`, and SC-001
reconciles change plans against reproduction results continuously. A view has no write path, which
is the cheapest way to make "no path exists that can bypass the check" a structural statement rather
than an assertion about the code. It composes with 006's `fix_eligibility`: two independent views,
both of which must be true, neither of which any code can set.

## R-17 · Boundary shapes: what these results cross as

**Decision**: nothing new is added to the runner's closed evidence list (012 FR-022). Results map
onto existing shapes:

| This feature produces | Crosses as |
|---|---|
| parsed test results | `test_result` |
| observed failure signature | `error_signature` |
| touched files, fixture paths | `file_path` |
| exit code, resource usage, egress denials, limit breaches | `tool_output_summary` |
| a rung skipped because a capability was refused | `collection_gap` |

Raw log bodies, source files and fixture contents do not cross in any shape (FR-026, 012 FR-023),
verified by a contract test on the boundary schema (SC-009).

**Rationale**: `tool_output_summary` is defined as "tool name, outcome, structured fields declared
by that tool", which is exactly what a sandbox run's denials and resource readings are. Adding new
top-level shapes would widen the surface a customer's security review reads, for facts that already
have a home.

## R-18 · `observedRate` is the rate of the rung that produced the FAIL

**Decision**: repeat counters live on the per-rung attempt row — `rung_attempt.observed_runs` and
`rung_attempt.reproduced_runs`. The attempt-level `observed_runs`, `reproduced_runs` and
`observed_rate` carried to 008 are a **copy of the reproducing rung's row**, not an aggregate across
rungs. Rungs that did not reproduce keep their counts on their own rows and contribute nothing to the
headline rate. 008's "full repeat count" for GREEN (008 FR-011) is therefore exactly this
`observed_runs`.

**Rationale**: aggregating across rungs produces a number with no meaning — a failure that reproduces
10/10 at `data` and 0/2 at `unit` is not "10 of 12". 008 uses the rate to decide how much a GREEN is
worth, and the only rate relevant to that is the one from the rung the regression test will run at.

**Alternatives**: a weighted aggregate (no defensible weights); reporting every rung's rate (008 then
has to pick one, which moves the decision without removing it).

## R-19 · Egress denial is recorded as configuration, not captured as syscalls

**Decision**: the run container has no default route and no DNS (R-08). The supervisor records that
fact — route table empty, resolver absent, allowlist digest — as `execution_run.egress_posture`. It
does **not** intercept `connect()`. A failed connection surfaces the way any failure surfaces: in the
test output the adapter already parses.

Consequences, followed through: `egress_denial.phase` has the single value `prefetch`, because only
the prefetch proxy can deny anything; FR-011 and SC-003 are stated against the recorded posture rather
than against captured syscalls; and the red-team fixture asserts the failure and the posture, not a
denial row.

**Rationale**: capturing denied syscalls needs seccomp-notify, eBPF or ptrace — a new runtime
dependency and a new privileged component, to observe something the absence of a route already
guarantees. The security property is the absent route; syscall capture would only make it observable,
and the test output already makes it observable enough to debug.

**Alternatives**: eBPF or seccomp-notify (a new privileged dependency for diagnostic convenience,
against constitution VIII); a proxy that denies and logs (a proxy is a route, which is the thing we
removed).

## R-20 · The fixture scanner reuses 003's redaction ruleset

**Decision**: scanning a fixture for secrets and personal data uses the same versioned detector set as
collection redaction (003 R-07a), at the same version, resolved from the same reference data. 007
carries no ruleset of its own.

**Rationale**: two detector sets drift, and the one that drifts is always the one with fewer eyes on
it. A fixture leaving the sandbox and an excerpt leaving the collector are the same risk with the same
patterns.

## R-21 · A separate defect finding is surfaced, never auto-raised

**Decision**: when reproduction produces a *different* failure signature, the finding is recorded and
surfaced with `raised_issue_id` null. A human decides whether it is a second bug and raises it through
normal ingestion, which then fingerprints it like any other signal.

**Rationale**: auto-raising means a flaky environment manufactures issues, each carrying cost and
attention. And an issue raised by the system from a single sandbox observation has no production
signal behind it — it would be the only issue in the system with no evidence from reality.

## R-22 · Two ladders, selected by where the symptom is observable

**Decision**: the rung vocabulary splits into a **server ladder** (`unit` · `request` · `data` ·
`concurrency` · `load` · `external_state`) and a **client ladder** (`client_unit` · `client_request` ·
`client_journey`). The diagnosis directive carries `observableLocation` ∈ `server` · `client`, and that
field — not the issue's kind — selects the ladder. An undetermined location yields `INCONCLUSIVE`
with reason `observable_location_undetermined`.

**Rationale**: for a symptom observable only in the browser — a spinner that never stops, a request
never sent, a mishandled response — `unit` and `request` cannot produce a `FAIL` **in principle**. One
ladder would climb two rungs that are guaranteed to fail before reaching an instrument that can see
anything. Conversely, driving a browser to reproduce a log-derived endpoint error means booting a
frontend and installing browsers to arrive at an HTTP request the engine could have made directly —
orders of magnitude more cost for identical evidence.

`client_unit` leads the client ladder because a large share of "the spinner never stops" is a state
machine that never leaves `loading`, reproducible in milliseconds against the store with no browser
and no build.

**Alternatives**: one ladder with browser rungs appended (wastes two rungs by construction on every
client-observable issue, and invites a browser run for backend errors); selecting the ladder by issue
kind (a user report frequently has a server-observable symptom, and an alert can fire on a
client-side error reporter — kind does not predict location).

## R-23 · `client_journey` requires a declared reason

**Decision**: the browser rung needs the customer's frontend build, browsers in the runner image and
a locally served application against a local or stubbed backend, since the sandbox has default-deny
egress (R-19). It is refused when a cheaper rung on its own ladder was never attempted, and the
refusal is recorded.

**Rationale**: it is the most expensive operation in the product and the flakiest. A rung that costs
minutes and can report a false `PASS` under timing pressure should not be reachable by omission.

**Alternatives**: treating it as an ordinary rung (it gets reached by default and dominates cost);
excluding the browser entirely (then the frontend half of v1 has no reproduction path at all, and the
most compelling demo — "click Pay, the spinner never stops" — is unreproducible).

## Unresolved

The PII position (FR-024) and fixture retention (C-04) are decided product commitments, not open
questions; R-06 implements them and states the one place C-04 costs something real. Everything else
above is settled.

None.
