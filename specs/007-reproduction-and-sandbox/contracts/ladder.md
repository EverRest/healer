# Contract: the reproduction ladder

**Normative.** This document owns the rung vocabulary. 006 imports it and does not restate the
values; a second definition would drift on the first change and surface as a directive naming a rung
the engine does not have — at run time, inside the customer's network (research R-01).

Contract version: `1`. Adding a rung, changing an order, or changing the meaning of a result is a
version bump visible to 006, 008 and 011.

## The rungs

## There are two ladders, selected by where the symptom is observable

A ladder is chosen by the diagnosis directive's `observableLocation` (006), **not** by the issue's
kind. Who reported a problem says nothing about which instrument can see it.

| `observableLocation` | Ladder | Because |
|----------------------|--------|---------|
| `server` — a response, an exception, server state | the server ladder below | The failing observable is reachable by calling code or making a request |
| `client` — a rendered state, a request never sent, a mishandled response, a browser exception | the client ladder below | No server log shows it. `unit` and `request` cannot produce a `FAIL` **in principle**, so climbing them would waste two rungs by construction |

A directive whose `observableLocation` is `client` MUST NOT be given the server ladder, and the
reverse likewise. Where diagnosis cannot determine the location, the outcome is `INCONCLUSIVE` with
reason `observable_location_undetermined` — guessing costs a full browser run to learn nothing.

### Server ladder

Ordered cheapest to most expensive. The engine climbs ascending and **stops at the first rung that
reproduces** (FR-002). Cost is also trust: the cheapest rung that reproduces is the rung whose
result is most repeatable and whose fixture is least likely to contain customer data.

| order | key | What it needs | Typical cost | Repeat policy |
|-------|-----|---------------|--------------|---------------|
| 1 | `unit` | an entry point callable in process | seconds | run once, confirm once on `FAIL` |
| 2 | `request` | application boot, a request the handler accepts | tens of seconds | run once, confirm once on `FAIL` |
| 3 | `data` | an input of a specific shape (fixture construction, below) | needs a fixture | once |
| 4 | `concurrency` | two or more interleaved entry points | flaky by nature | `n` repeats, rate recorded |
| 5 | `load` | a load harness the repository provides | expensive | `n` repeats, rate recorded |
| 6 | `external_state` | a state of a system we do not control | usually impossible | once |

Rungs 4 and 5 are declared as `n`-repeat because their honest answer is a rate, not a boolean
(research R-04). Rung 6 exists so that "this needs a state we cannot create" is a recorded rung
outcome rather than a missing record.

### Client ladder

| order | key | What it needs | Typical cost | Repeat policy |
|-------|-----|---------------|--------------|---------------|
| 1 | `client_unit` | a component or store callable in a test runner, no browser | milliseconds | run once, confirm once on `FAIL` |
| 2 | `client_request` | the recorded failing request replayed against the client's handling, no browser | seconds | run once, confirm once on `FAIL` |
| 3 | `client_journey` | a real browser driving a real build (Playwright) | **the most expensive rung in the product** | `n` repeats, rate recorded |

`client_unit` first is not a formality. A large share of "the spinner never stops" is a state machine
that never leaves `loading` — reproducible in milliseconds against the store, with no browser, no
build and no flakiness.

**`client_journey` requires a declared reason.** It needs the customer's frontend build, browsers in
the runner image, and a locally served application — and the sandbox has default-deny egress
(research R-19), so the frontend must run against a local or stubbed backend. It is the one rung
whose cost justifies refusing it when a cheaper rung was never attempted.

### What collapses the expensive path

Most client-observable reports name the failing request somewhere: a trace identifier, a HAR, a
browser console log. When intake captures one (009), the directive's `observableLocation` is still
`client` but rung 2 has everything it needs and the browser is never reached. **Asking the reporter's
system for a trace identifier is the cheapest cost control in this feature.**

## The directive — 006 to 007

Produced per diagnosis (006 FR-017). Diagnosis executes nothing.

```jsonc
{
  "directiveId": "uuid",
  "issueId": "uuid",
  "diagnosisId": "uuid",
  "suggestedRung": "concurrency",   // a hint from diagnosis
  "maxRung": "concurrency",         // a CEILING — not a starting point
  "entryPoint": {                   // resolved against the architecture graph (004)
    "componentId": "uuid",
    "symbol": "OrderHandler.create",
    "endpointTemplate": "POST /orders"
  },
  "preconditions": { "…": "declared state the rung requires" },
  "failingObservable": {            // the issue's normalised error signature (001 FR-002, FR-003)
    "rulesetVersion": 7,
    "exceptionType": "…",
    "frames": ["…"],
    "endpointTemplate": "…",
    "errorCode": "…"
  },
  "dataRequirements": {             // SHAPE ONLY — field presence, types, bounds, encoding
    "…": "never a value from a production record"
  }
}
```

**`maxRung` is a ceiling, `suggestedRung` is a hint.** The engine always begins at `unit` and never
attempts a rung above `maxRung`. This is why 006 FR-017 names a suggested rung and a maximum rung
rather than a single target rung, which would contradict 007 FR-002 ("attempt cheapest first",
"stop at the first rung that reproduces"): diagnosis contributes
what it knows — a race will not reproduce in process — without overriding the economics this engine
owns, and SC-002 stays verifiable.

A rung above `maxRung` is recorded as `skipped` with reason `above_max_rung`. It is not silently
absent (FR-003).

## The result — 007 to 008, 002 and the human

```jsonc
{
  "attemptId": "uuid",
  "issueId": "uuid",
  "diagnosisId": "uuid",
  "result": "FAIL",                 // PASS | FAIL | INCONCLUSIVE
  "inconclusiveReason": null,       // required when INCONCLUSIVE, from the closed set below
  "reproducingRung": "unit",        // non-null exactly when result is FAIL
  "observedRuns": 10,               // the REPRODUCING rung's counters, copied — never a sum (R-18)
  "reproducedRuns": 3,
  "intermittent": true,
  "observedRate": 0.3,              // carried to 008; this feature does not judge it
  "ladder": [
    { "rung": "unit", "outcome": "reproduced", "durationMs": 4100,
      "observedRuns": 10, "reproducedRuns": 3,
      "executionRunId": "uuid", "resourceCost": { "…": "…" } }
  ],
  "budgetConsumed": { "wallClockS": 42, "spend": 0.0 }
}
```

### Result vocabulary

| Result | Meaning | Effect on the change path |
|--------|---------|---------------------------|
| `FAIL` | **the reported failure was reproduced** — signature equality under the issue's own normalisation ruleset version | opens (FR-001), subject to 006's `fix_eligibility` also holding |
| `PASS` | it ran cleanly; not reproduced. The diagnosis is marked unconfirmed by execution | stays closed |
| `INCONCLUSIVE` | it could not be determined | stays closed, routes to a human with the ladder and the rejected hypotheses (FR-006) |

`FAIL` is the counter-intuitive one and it is deliberate: the reproduction *failing* is the success
condition, because a failing reproduction is the first evidence produced by execution rather than by
a model.

### Signature equality (FR-005)

A `FAIL` requires, under the **issue's recorded** `normalisation_ruleset` version (001 R-01):

- identical normalised `exceptionType`
- identical normalised `errorCode`
- the issue's normalised frame sequence is a **contiguous suffix** of the observed sequence
- identical `endpointTemplate` where the issue carries one

The suffix rule is the one relaxation, for the test-harness frames a sandbox stack has and
production does not; the innermost frame stays identical. Anything else is `INCONCLUSIVE` with
reason `signature_mismatch`, plus a separate-defect finding — it may be a second bug.

### `inconclusiveReason` — closed set

| Reason | What the human does next |
|--------|--------------------------|
| `no_rung_reproduced` | read the ladder; the surviving hypotheses are the starting point |
| `signature_mismatch` | look at the separate-defect finding |
| `build_failure` | fix the build at that commit; the build output is attached as evidence |
| `environment_failure` | the environment could not be made runnable |
| `timeout` | a wall-clock limit was reached; the process tree was killed |
| `unparseable_output` | the runner produced no machine-readable report |
| `no_test_command` | declare a test command in tenant configuration (FR-020) |
| `commit_unavailable` | the commit was force-pushed or the branch deleted |
| `budget_exhausted` | the per-issue budget stopped the climb (002 FR-011) |
| `capability_refused` | the runner lacks a capability; upgrade it (C-02) |

None of these may be recorded as `PASS` (FR-016, FR-019, SC-006). All route to a human.

### Rung outcomes

`reproduced` · `not_reproduced` · `skipped` (with a reason) · `error` (with detail).

Only `not_reproduced` is evidence. A skip and an error are gaps, and the handoff needs to
distinguish "the concurrency rung did not reproduce it" from "there was no concurrency entry point"
(research R-03).

## Fixture construction — rung `data`

Attempted **in this order**, stopping at the first that reproduces (FR-024). The order is a product
commitment that appears in the DPA; relaxing it is a contract change, not a configuration change.

```text
1  request_shape   field presence, types, lengths, encoding — no payload      ← always try first
2  synthetic       generated to satisfy the failing constraint
3  anonymised      only under an explicit, recorded tenant grant; irreversible
   raw production payload                                                      ← never, in any mode
```

Every candidate fixture is scanned for secret and personal-data patterns before use; a detection
blocks it and raises the finding (FR-025).

**Nothing is retained** (C-04). The fixture lives on the run container's tmpfs and dies with it.
What reaches 008 is the **recipe** — the shape descriptor for `request_shape`, the generator
parameters and seed for `synthetic` — which 008 materialises and commits to the customer's
repository with the regression test, where their test data already lives.

An `anonymised` fixture has **no recipe**: describing an extract precisely enough to regenerate it
is a way of carrying it. If the only rung that reproduced required an anonymised extract, 008 attempts
a synthetic equivalent and routes to a human when it does not reproduce — its `NO_RECIPE` off-ramp
(research R-06, C-23, 008 FR-011a).

## What crosses the plane boundary

Only structured results (FR-026, 012 FR-022). Nothing new is added to the runner's closed evidence
list; these map onto existing shapes:

| This engine produces | Crosses as |
|---|---|
| parsed test results | `test_result` |
| observed failure signature | `error_signature` |
| touched files, fixture paths | `file_path` |
| exit code, resource usage, egress denials, limit breaches | `tool_output_summary` |
| a rung skipped for a refused runner capability | `collection_gap` |

Raw log bodies, source file contents and fixture payloads do not cross in any shape. Verified by a
contract test on the boundary schema (SC-009).

## Execution requests

Agents reach the sandbox through exactly two declared, schema-validated, permission-checked and
audited tools. There is no shell (FR-028).

```text
runReproduction(directive)   → an attempt result
runTests(selector)           → parsed test results for a named subset
```

The sandbox has no credential, socket or route to the control plane other than this contract.
