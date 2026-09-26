# Roadmap

## North Star

```text
Observe → Understand → Diagnose → Act → Verify → Learn → Document
```

A closed loop where evidence, policy and verification decide — not the model.

## Stage 0 — blockers

See [stage-0.md](stage-0.md). S0-1 (incident history audit) blocks realistic planning of v1.

## Stage 1 — specifications

All 12 `spec.md` written 2026-09-23: 340 functional requirements, 133 success criteria.
All 7 clarifications resolved 2026-09-24 (C-01..C-07 in [decisions.md](decisions.md)) — zero open.
All 12 spec sets complete and analyzed, 2026-09-24 — spec, plan, research, data-model, contracts,
quickstart and tasks. After the stage-0 review the same day: **366 functional requirements, 138 success
criteria, 1 166 tasks**, 235 research entries, 29 contract documents, 587 quickstart scenarios.
After 012 US10 (agent-driven development), ADR 0010 (inference follows the source), C-36..C-42 and
013 (regression suite, specified through tasks and analyzed), 2026-09-26: **13 specs, 399 functional
requirements, 148 success criteria, 1 221 tasks**, 250 research entries, 31 contract documents, 613
quickstart scenarios.
988 cross-spec requirement references, 112 cross-spec task references, every internal link — all
resolve. 11 OpenAPI documents valid, no duplicate path keys, FR coverage 366/366 (399/399 after 2026-09-26, including 013 and 008 FR-016a).

`/speckit-analyze` found ≈110 findings (10 CRITICAL, ~47 HIGH) — every spec was internally complete,
and all of it sat at the **seams between specs**. Resolved as C-08..C-28 in [decisions.md](decisions.md).

The **stage-0 review** (C-29..C-32, constitution 1.1.0, [ADR 0009](adr/0009-derivation-artifacts-and-diff-gates.md))
then closed the two findings that mattered most: the autonomy thresholds were to be measured on the same
incidents the prompts are tuned against, and nothing required them to be read at the moment a ceiling is
raised. The benchmark set is now sealed and a raise is gated on the build — see
[runbooks/raising-autonomy.md](runbooks/raising-autonomy.md).

## Stage 2 — implementation

**012 phases 1–2 landed 2026-09-24** (VERSION 0.5.0): the monorepo, shared foundations, tenancy as a
compile-time guarantee, the transactional outbox, the persisted workflow machine, the callback registry
and the seven queue classes. `typecheck`, `lint`, `format-check` and 48 unit tests green; the compose
stack and the migration are written but unapplied, because the Docker daemon was down — noted in 012's
tasks.md rather than left implicit.

Next: 012 phase 3 (`make ci`, `db-check` and the gate harness — which also runs the migration e2e test
that is already written), then 001 phases 1–2. Stage 0 S0-1 still blocks realistic sizing of v1 and does
not block this work.

| Spec | Covers | clarify | plan | tasks | analyze |
|------|--------|---------|------|-------|---------|
| 001 issue-and-evidence | `Issue` aggregate, `Evidence`, audit trail, event model | ✅ | ✅ | ✅ | ✅ |
| 002 policy-and-autonomy | Policy Engine, autonomy levels, approvals, budgets | ✅ | ✅ | ✅ | ✅ |
| 003 context-resolver | Evidence collection across the control/execution split, redaction | ✅ | ✅ | ✅ | ✅ |
| 004 architecture-graph | `Component`, `DeploymentUnit`, discovery, code/runtime/product graphs | ✅ | ✅ | ✅ | ✅ |
| 005 knowledge-and-expected-behavior | Knowledge sources, provenance, `ExpectedBehavior`, drift | ✅ | ✅ | ✅ | ✅ |
| 006 diagnosis | Hypotheses, evidence validation, is-this-a-code-problem classifier | ✅ | ✅ | ✅ | ✅ |
| 007 reproduction-and-sandbox | Reproduction engine, isolation, `INCONCLUSIVE` path | ✅ | ✅ | ✅ | ✅ |
| 008 change-and-verification | Impact analysis, TDD fix, verifier, PR automation | ✅ | ✅ | ✅ | ✅ |
| 009 autosupport | Issue intake, grounded answers, answer policy | ✅ | ✅ | ✅ | ✅ |
| 010 safe-remediation | Reversible actions, preconditions, verification, undo | ✅ | ✅ | ✅ | ✅ |
| 011 simulator-and-eval | Historical replay, benchmark harness, metrics | ✅ | ✅ | ✅ | ✅ |
| 012 engineering-foundation | Monorepo, CI, lint gates, runner packaging, observability | ✅ | ✅ | ✅ | ✅ |
| 013 regression-suite | Adopted expectations → tests → CI; a failing test becomes a `regression` issue | ✅ | ✅ | ✅ | ✅ |

Dependency order for planning: 012 → 001 → 002 → 003 → 004 → 005 → 006 → 011 → 009 → 010 → 007 → 008 → 013.

Note that **policy (002), evidence (001) and the eval harness (011) come before anything that
writes** — several exit criteria in the original brainstorm depended on components scheduled
much later, which made those phases unverifiable.

## v1 release shape

```text
Read-only core      issue → context → evidence → diagnosis, policy, audit, simulator
AutoSupport         propose only, never sends
Safe remediation    reversible actions including autonomous rollback
TDD fix + PR        L2 ceiling — human always merges
```

## Beyond v1

L3 (merge) only after a measured false-fix rate. L4/L5 per component and environment, never
globally. Wiki generator, postmortems, evidence graph views, model router.
