# Quickstart: regression suite

## Prerequisites

A tenant with a connected runner that declares `inference` (012 FR-046a), a repository with 005's
expectation documents path configured, the CI adapter confirmed in S0-4, and the selection step added
to the customer's pipeline ([contracts/selection.md](contracts/selection.md)).

```bash
make bootstrap
make test-e2e -- regression      # the scenarios below, against disposable Postgres and Redis
```

## Scenarios

| # | Scenario | Do | Expect |
|---|----------|----|--------|
| 1 | Draft is not an anchor | request a test for an expectation whose pull request is unapproved | refused and recorded (FR-007) |
| 2 | Adoption by approval | a human approves the draft pull request | expectations adopted per 005 R-16; tests may now be requested |
| 3 | Healer cannot adopt | the approval comes from Healer's identity | not adopted (005 R-17) |
| 4 | Vacuous test | the test author produces a test with no assertion on a constraint key | refused as vacuous (FR-008, R-07) |
| 5 | Passes on base | a written test passes against the default branch | test pull request opened, naming expectation, version and adopting human |
| 6 | Fails on base | a written test fails against the default branch | no pull request; one `automated_detection` issue (FR-010) |
| 7 | API drafts | an OpenAPI document with 40 operations | every operation and documented response code drafted, 0 model calls (FR-003, SC-002) |
| 8 | Draft cap | a component already at 25 open draft expectations | drafting opens nothing new for it (FR-005) |
| 9 | Selection by closure | change a file whose component carries three bindings and sits on one flow | those three plus the flow's journey selected (FR-013) |
| 10 | Selection widens | change a path mapping to no component; separately, make Healer unreachable | `FULL_SUITE` both times, with the reason (contracts/selection.md) |
| 11 | Regression issue | a binding that passed at commit A fails at B on the default branch | one `regression` issue with result, both commits and the range as evidence (FR-015) |
| 12 | Grouping | the same binding fails five nightly runs in a row | 1 issue (FR-016, SC-004) |
| 13 | Fan-out | 40 bindings fail in one run | 1 incident listing all 40 (FR-016) |
| 14 | Pull-request failure | a binding fails only on a pull request branch | no issue (FR-017) |
| 15 | Quarantine | a binding flips between runs on the same commit | quarantined, counted uncovered, its failures create no issues (FR-019, SC-005) |
| 16 | Expectation changes | adopt a new version of a bound expectation | binding `stale`, a test pull request against the new version (FR-020) |
| 17 | Test edited to pass | a change edits a bound test's assertion with the expectation version unchanged | masking candidate, human approval required (FR-021) |
| 18 | Human-written test | a person adds a test with a valid `@expectation` annotation | bound with `origin = human` (R-06) |
| 19 | Report stays home | plant a marker in a failing test's message and in a test file | marker absent from every control-plane table, log and payload (012 SC-011) |
| 20 | Isolation | read another tenant's coverage, bindings, and call selection with another tenant's CI credential | 404 each time (012 FR-013) |
