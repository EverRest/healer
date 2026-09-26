# Implementation Plan: Regression suite

**Branch**: `013-regression-suite` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-26

## Summary

Regression testing that runs the way fixes already run. Healer drafts expectations for every API and
page, a human adopts them by approving a pull request, a runner-side agent turns each adopted
expectation into a test that must pass on the default branch, a human merges it, the customer's CI
runs the tests a change can affect on every pull request and all of them on a schedule and after a
deploy — and a failure on the default branch becomes a `regression` issue in the one pipeline, with
its anchor already adopted.

Two ideas shape it. **There is no second store of expected behaviour**: a scenario is 005's
`ExpectedBehavior`, the only new entity is the binding between a test and an adopted version.
**Selection may widen and never narrow**: every failure mode of the selection path runs more tests.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS — as 012

**Primary Dependencies**: none new. 004 impact closure, 005 markdown ingest, 007 report adapters and
sandbox, 008 masking and quarantine, 012 runner protocol and workflow engine

**Storage**: PostgreSQL, schema `regression` ([data-model.md](data-model.md))

**Testing**: Vitest, Supertest, Testcontainers (012 R-12)

**Target Platform**: control plane (bindings, selection, issues, coverage); runner (drafting, test
authoring, report parsing, annotation scanning — ADR 0010); customer CI (execution)

**Project Type**: a domain module in the existing monorepo

**Performance Goals**: selection answers within 1 s at p95 for a thousand changed paths — the CI
step's own timeout falls back to the full suite, so latency costs time, never coverage

**Constraints**: no test code, report body or draft text crosses (012 FR-022); no merge and no
adoption operation exists (FR-011, 005 R-16)

**Scale/Scope**: first year — up to a few thousand bindings per tenant, one selection per pull request

## Constitution Check

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every regression issue carries the failing `test_result`, both commits and the range as evidence records (FR-015) | ✅ |
| II. Anti-Circular Verification | Tests only for expectations with an active anchor grant, adopted by human approval; assertions must reference the adopted constraint; a test edited to pass is a masking candidate (FR-007, FR-008, FR-021) | ✅ |
| III. Reproduce Before Modify | A regression issue enters 007 like any other; the bound test is a candidate reproduction, not a waiver | ✅ |
| IV. Deterministic Control | Selection, binding, grouping and coverage are deterministic; the only model calls are drafting and test authoring, and neither gates anything | ✅ |
| V. Dependency-Aware Change | Selection is 004's impact closure, never narrowed | ✅ |
| VI. Serialize / Parallelize | Observed runs are events plus collection directives; no job waits for CI (012 FR-025) | ✅ |
| VII. Architecture Agnostic | Subjects are 004 nodes; rungs are 007's; no framework named in the domain | ✅ |
| VIII. Simplicity | No new dependency, three tables, coverage computed not stored | ✅ |

## Project Structure

```text
specs/013-regression-suite/
├── plan.md · research.md · data-model.md · quickstart.md · tasks.md
└── contracts/
    ├── selection.md      # the CI step and its fall-back rule
    └── openapi.yaml      # selection, coverage, bindings

packages/domain/regression/     # bindings, selection, failure-to-issue rule, coverage query
packages/agents/test-author/    # runner-side agent (ADR 0010)
apps/runner/                    # drafting, annotation scanner, report collection via 007 adapters
```

## Phase 0 — research

[research.md](research.md): scenarios as 005 expectations (R-01), adoption by approval (R-02),
runner-side drafting (R-03), selection (R-04), observed runs (R-05), bindings from annotations (R-06),
the test author (R-07), failure rules (R-08), computed coverage (R-09).

## Phase 1 — design

- [data-model.md](data-model.md) — `test_binding`, `suite_run`, `selection_request`, and the
  cross-feature additions raised against 001, 002, 005 and 012.
- [contracts/selection.md](contracts/selection.md), [contracts/openapi.yaml](contracts/openapi.yaml).
- [quickstart.md](quickstart.md) — twenty scenarios, each a failing-first test.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| A synchronous CI → Healer call | Selecting per pull request needs the graph, which lives in the control plane | Running the full suite on every pull request is the fallback, not the design — it makes the suite too slow to run per change, so it would be run nightly and find regressions a day late |
| A new crossing shape (`test_binding_ref`) | Bindings must include human-written tests and later edits (R-06) | Binding only on merge of Healer's pull request misses both |
