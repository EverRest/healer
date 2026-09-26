# Phase 0 Research: regression suite

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · A scenario is an `ExpectedBehavior`, in 005's markdown format

**Decision**: no scenario entity. A regression scenario is an `expected_behaviors` entry in 005's
repository markdown front matter (005 R-08), extended with three optional keys per entry — `subject`
(`endpoint` · `page` · `flow`, with its 004 reference), `given` / `when` / `then` (strings for the
reviewer), and `priority`. Constraints stay where 005 already parses them, and they — not the
Given/When/Then prose — are what a test asserts (FR-008).

```yaml
expected_behaviors:
  - id: checkout-014
    description: a discount is applied at most once per order
    subject: { kind: endpoint, ref: 'POST /orders/{id}/discounts' }
    given: an order with discount code SAVE10 applied
    when: the same code is applied again
    then: the order total is unchanged and the response is 409
    priority: high
constraints:
  max_discount_applications_per_order: { type: int, value: 1 }
```

**Rationale**: a second store of expected behaviour would drift from 005 within a release, and 005
already has versioning, adoption, anchor grants and drift detection. The extension is additive, so a
005 document without it still parses.

**Alternatives**: a `scenario` table in this feature (two authorities for one fact); Gherkin files
(a second format for the customer to review, and a parser for prose we would then be tempted to
interpret).

## R-02 · Adoption is pull-request approval, and drafts arrive as pull requests

**Decision**: drafting ends in a pull request against the expectation documents, opened by Healer's
identity. Approving it adopts every expectation it contains (005 R-16); Healer's identity can never be
the approver (005 R-17). The engineer edits or deletes drafts in the pull request before approving.
The per-component cap (FR-005) counts expectations in open draft pull requests.

**Rationale**: C-06 made code review the adoption gate, deliberately. A second adoption path for
scenarios would be the weaker gate everyone uses.

## R-03 · Drafting runs in the runner

**Decision**: both drafting paths execute in the runner: API drafts from the OpenAPI document with no
model call (FR-003), page and journey drafts with a model reading routes and components (FR-004,
ADR 0010). The draft text never crosses; the control plane receives `pull_request_ref` and a count
per component.

**Rationale**: the OpenAPI document, routes and components are customer content. A draft derived from
them is customer content too, and its destination is the customer's repository anyway.

## R-04 · Selection: changed paths in, test paths out

**Decision**: a CI step in the customer's pipeline sends the pull request's base, head and changed
paths to `POST /regression/selection` with a tenant-scoped CI credential. Healer maps paths to
components (004 repository mapping), computes the impact closure, adds every `flow` through those
components, and returns the bound tests' paths. Each request is recorded (`selection_request`), so a
test that did not run can be explained afterwards. Unreachable Healer, a timeout or an unknown path
→ the step selects the full suite and says why.

**Rationale**: paths already cross (012 FR-022). The closure is 004's, with no confidence parameter,
so an unconfirmed edge only adds tests (C-03). Component-level selection is coarser than a symbol
graph and errs towards running more — the safe direction.

**Alternatives**: a symbol-level change graph from the runner for every pull request (a runner round
trip inside the customer's CI, for a saving the full-suite fallback does not need); selection in the
CI step with a copy of the graph (a second copy of the graph in every pipeline).

## R-05 · Runs Healer did not request

**Decision**: scheduled, post-deploy and person-authored pull-request runs are observed, not
delegated. The CI host's pipeline event reaches Healer through the existing CI adapter; Healer
records a `suite_run` and issues a collection directive; the runner fetches the machine-readable
report and parses it with 007's adapters (007 R-10) into `test_result` evidence. Runs requested by
Healer itself keep 007 R-11's `ci_delegation` path.

**Rationale**: one parser, one evidence shape, and report contents — which include failure messages —
stay in the customer's network.

## R-06 · Bindings are declared in the test, observed by the runner

**Decision**: a bound test carries an annotation naming its expectation and adopted version
(`@expectation checkout-014@3`). The runner's code intelligence reads annotations on the default
branch and reports each as a `test_binding_ref` shape — test identifier, path, expectation identifier,
version — and the control plane reconciles `test_binding` rows from them. A test Healer wrote and a
test a person annotated are bound the same way.

**Rationale**: the test file is the authority for which expectation it asserts; a table written only
when Healer's pull request merged would miss every human-written test and every later edit.

**Alternatives**: bind on merge of Healer's test pull request only (misses human tests and edits);
naming convention on test titles (prose, and prose drifts).

## R-07 · The test author is a runner-side agent that must pass on the base

**Decision**: a new agent kind `test_author`, executed in the runner under `agent_directive` and
`RepositoryWriteCapability` for pull-request creation only. It picks the lowest rung of 007's ladder
that can observe the expectation's subject (FR-009), writes the test with its annotation, and runs it
against the default branch in the sandbox. Passing → pull request. Failing → no pull request, and an
`automated_detection` issue (FR-010). Vacuity is checked deterministically: every assertion-bearing
test must reference at least one constraint key of its expectation version, read by the same
annotation scanner as R-06.

**Rationale**: for existing behaviour, red-first (012 R-14) is the wrong rule — the behaviour already
exists, so a correct new test is green. What proves the test is not vacuous is that it asserts the
adopted constraint; what proves it is not tautological is that its assertion's value comes from the
expectation, not from observing the code.

## R-08 · Failures become issues only where they mean regression

**Decision**: an issue is created for a bound test failing on the default branch or a declared
environment after it passed on an earlier commit (`regression`); for a test that has never passed
since binding (`automated_detection`); never for a pull-request branch (FR-017). The fingerprint is
the binding identifier plus environment, as a new version of 001's normalisation ruleset. More than
10 failing bindings in one run group into one incident whose evidence lists all of them.

**Rationale**: a pull request's red build belongs to its author, not to the incident queue. A suite
failing wholesale is almost always an environment problem, and one incident is how 006 gets to call it
`NOT_A_CODE_PROBLEM` once instead of a hundred times.

## R-09 · Coverage is computed, not stored

**Decision**: coverage is a query over 004's endpoint, page and flow nodes, 005's expectations by
state, and `test_binding` by state (FR-023, FR-024).

**Rationale**: a coverage table is a second copy of three facts that change independently.

## Unresolved

None. Starting values — 25 open draft expectations per component, a fan-out bound of 10 — ship as
fail-closed starting values (C-32) and are tuned from S0-5.
