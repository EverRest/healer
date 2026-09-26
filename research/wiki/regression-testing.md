# Regression testing

Why regression suites fail in practice, and what Healer's suite (spec 013) does differently. The
design is in [013](../../specs/013-regression-suite/spec.md); this page is the reasoning.

## Why suites rot

Most teams have a regression suite that nobody trusts, for four reasons that compound:

| Reason | What it looks like | Why it is silent |
|---|---|---|
| Tests assert what the code did, not what it should do | A bug is "covered" by a test that expects the buggy value | The suite is green; the bug is now protected |
| Flaky tests are rerun until green | "Just retry the pipeline" becomes the fix | A real intermittent failure is indistinguishable from noise |
| Selection skips what a change can reach | Fast pipelines on pull requests, a slow nightly nobody reads | The regression merges green and is found a day later |
| Failures land in a separate report | A red nightly build, a channel, a dashboard | A second queue that nobody triages |

Generating tests with a model makes the first one worse, not better: a model reading code writes down
the code's behaviour fluently and at scale. See [failure-modes](failure-modes.md) §13.

## The anchor is the whole idea

A test is only a judge if its expected value came from somewhere other than the thing it judges. In
Healer that somewhere is an `ExpectedBehavior` a human adopted — by approving the pull request that
added it (005 R-16) — and the test must assert that expectation's **constraint** (013 FR-008). This
is the same rule that makes a fix's regression test meaningful (008 FR-006); the suite is that rule
applied ahead of time instead of after an incident.

A consequence that looks backwards at first: when the test author writes a test for an adopted
expectation and the test **fails on the current code**, that is not a bad test to throw away. It is a
bug nobody reported, found before a customer did, and it becomes an issue (013 FR-010).

## Red-first does not apply, and that is correct

For new behaviour, a test that was never red proves nothing (012 R-14). For existing behaviour the
opposite holds: a correct new test is green, because the behaviour already works. What proves the test
is not vacuous is that it references the adopted constraint; what proves it is not a mirror is that the
constraint's value came from a human, not from observing the code.

## Selection

Running only the tests a change can affect is what makes per-change runs affordable. Healer selects from
the impact closure (004), which has no confidence parameter, so an unconfirmed edge adds tests and never
removes them. Every failure mode of selection — an unknown path, an uncomputable graph, Healer being
unreachable — selects the full suite (013 contracts/selection.md). See [failure-modes](failure-modes.md)
§15.

## One queue

A default-branch failure is a `regression` issue in the same pipeline as an alert: fingerprinted,
classified, reproduced, and — where policy permits — fixed. The bound expectation is already adopted, so
the fix has its anchor before anyone opens the issue. A failure on a pull request branch creates no issue;
it belongs to that pull request.

A suite failing wholesale is almost always an environment problem. Above a fan-out bound the failures
group into one incident, so 006 can classify it `NOT_A_CODE_PROBLEM` once instead of a hundred times.

## The real bottleneck

Generation is cheap. Adoption is not. A thousand drafted scenarios nobody reads are worse than none,
because they look like coverage. Three things follow in 013:

- API drafts come from OpenAPI deterministically, with no model — the cheapest surface first.
- Drafts are capped per component and ordered by where incidents actually happen.
- The review time per draft is measured (S0-5); if it is too high the cap is lowered, not the review.

## What is not claimed

- Coverage of pages and journeys depends on the customer's CI being able to run browser tests; where it
  cannot, those subjects stay uncovered and the coverage view says so.
- The suite does not replace the customer's own tests. It adds tests bound to adopted expectations and
  tells the customer which of theirs are bound, if they annotate them.
