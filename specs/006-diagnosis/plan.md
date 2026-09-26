# Implementation Plan: Diagnosis — hypotheses, expected vs actual, and knowing when you don't know

**Branch**: `006-diagnosis` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

A `ContextSnapshot` (003) becomes a versioned `Diagnosis`: an issue classification, competing
hypotheses carrying what argues against them, a violated adopted `ExpectedBehavior` (005), and a
reproduction directive for 007 — or an honest `UNKNOWN`.

Three commitments shape the design. **The classifier is a stage, not a field**: it runs before any
hypothesis exists, and `diagnosis.classification_id` is `NOT NULL`, so there is no insert order in
which a hypothesis about a code defect precedes the decision that this is a code problem at all.
**Fix eligibility is a view, not a column** — a read-only SQL view over the latest classification,
the expectation violation and its adoption timestamp, so no code path exists that could set it, and
the policy engine (002 FR-001, 002 FR-005) reads a fact rather than a claim. And **a precedent's
conclusion is not representable**: `precedent_candidate` has no column holding a past root cause,
only a reference to that issue's own evidence records, which is why anchoring on a stale precedent
(`failure-modes.md` §6) cannot happen by omission of care.

The hard part is not generating hypotheses. It is making `UNKNOWN` and `INSUFFICIENT_CONTEXT`
persistable under 001 FR-009 — a conclusion with no evidence behind it is rejected, and "I don't
know" looks exactly like that. The resolution is R-07: the collection gaps from 003 are evidence.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`), Prisma 6, BullMQ, Zod (structured-output
schemas), Pino, OpenTelemetry. Model access only through `packages/llm` (012 FR-045)

**Storage**: PostgreSQL — schema `diagnosis`. Classification and diagnosis rows are append-only
versions; nothing is overwritten (FR-026). Precedent retrieval uses pgvector as a secondary index
over 001 fingerprints, never as the source of truth (ADR 0004)

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12). The classifier and the
precedent decay function are tested as pure functions — no model in the loop

**Target Platform**: control plane (ADR 0001). This feature executes nothing in the customer's
network; it consumes structured evidence and emits a directive

**Project Type**: domain package `packages/domain/diagnosis` plus the investigator agent's prompts
and output schemas in `packages/agents`

**Performance Goals**: classification decided by deterministic signal rules in under 2 s p95 with
no model call; a full diagnosis run under 4 min p95 including model latency; precedent retrieval
under 300 ms p95 over 50 000 past issues for one tenant; no worker job over its declared wall clock
(012 FR-027)

**Constraints**: recorded confidence reaches no gate, predicate or ordering (FR-015); diagnosis has
no write capability against `ExpectedBehavior`, the architecture graph or any repository —
enforced by the credential its agent holds, not by its prompt; at most two attempts per issue (D-08)

**Scale/Scope**: thousands of issues per tenant per month; three to six hypotheses per run; a
precedent corpus growing monotonically per tenant

## Constitution Check

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every classification, hypothesis and root cause carries evidence links emitted by the diagnosis step as it runs (FR-023, 001 FR-008). `UNKNOWN` is supported by the evidence that refuted each hypothesis; `INSUFFICIENT_CONTEXT` by `collection_gap` records (R-07) | ✅ |
| II. Anti-Circular Verification | The expected side comes from an adopted `ExpectedBehavior` that pre-dates the issue (R-05); diagnosis cannot author or amend one (FR-010). This is what makes 008's regression test non-circular | ✅ |
| III. Reproduce Before Modify | The classifier that guards the modify path is owned here and runs first (FR-001, R-01, R-03). Diagnosis produces a directive and executes nothing (FR-017) | ✅ |
| IV. Deterministic Control | Eligibility is a view over structural facts; confidence lives in a sibling table the policy package cannot import (R-09). Precedent decay is arithmetic, not judgement (R-08) | ✅ |
| V. Dependency-Aware Change | Affected components resolve against a pinned graph version (004 FR-014); an unconfirmed edge may only widen (004 FR-016a, C-03) | ✅ |
| VI. Serialize / Parallelize | Diagnosis is one node of the persisted workflow (012 FR-029). Retrieval fans out; the classification → hypothesis → violation sequence is serial by foreign key | ✅ |
| VII. Architecture Agnostic | The agent receives `SystemContext`; component identity comes from 004 and never from a service name | ✅ |
| VIII. Simplicity | The eligibility gate is a view and a `NOT NULL` constraint. No rules engine, no second policy | ✅ |

**Security**: the investigator agent's credential grants read-only tools (`.claude/rules/agents-and-llm.md`).
Its capability bundle (ADR 0008) contains no `RepositoryWriteCapability` and no
`DraftPublishCapability`, which is how FR-010's "diagnosis MUST NOT author an `ExpectedBehavior`"
is enforced — the function is unreachable, not merely uncalled. All snapshot content is data
(FR-021); the tool set is bound to the agent identity **before** the snapshot is loaded, and
instruction-shaped content is recorded as an anomaly rather than stripped — stripping hides the
attack (R-14).

**Tenancy**: `tenantId` on every table and in every query, precedent retrieval included — at the
query layer, never post-filtered (FR-027, 012 FR-048).

## Project Structure

### Documentation (this feature)

```text
specs/006-diagnosis/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml    # diagnosis reads, classification override, re-diagnosis trigger
    └── events.md       # what 006 publishes and consumes
```

### Source code

```text
packages/domain/diagnosis/
├── domain/
│   ├── classification/      # signal rules, verdict, taxonomy class (versioned ruleset)
│   ├── hypothesis/          # statement fingerprint, status transitions, promotion rule
│   ├── expectation/         # violation construction, adoption-timestamp rule
│   ├── precedent/           # decay function, liveness result, weight
│   └── outcome/             # the four outcomes and their preconditions
├── application/
│   ├── commands/            # ClassifyIssue, RunDiagnosis, ReDiagnose, OverrideClassification
│   └── queries/             # GetDiagnosis, ListVersions, GetFixEligibility, GetHandoff
├── infrastructure/          # Prisma repositories, precedent retrieval, graph resolution
└── presentation/            # controllers, DTOs

packages/agents/investigator/
├── prompts/                 # published to the registry (012 FR-038)
└── schemas/                 # Zod schemas for classification and diagnosis output
```

**Structure decision**: classification lives inside `diagnosis` rather than in its own package. It
is meaningless without the diagnosis it gates, it shares the same evidence links and the same
attempt record, and a separate package would put the `NOT NULL` foreign key that enforces ordering
across a module boundary — which is exactly the constraint that must not be optional.

The precedent decay function sits in `domain/`, not `infrastructure/`, because it is a product rule
with a threshold the stage-0 audit tunes, not a retrieval detail.

## Phase 0 — research

See [research.md](research.md). Resolves: why the classifier is a stage and not a field, how the
patch path is closed structurally, deterministic-signal-first classification, expectation matching
and the adoption-timestamp rule, how `UNKNOWN` and `INSUFFICIENT_CONTEXT` satisfy 001 FR-009,
precedent decay and non-representable conclusions, confidence isolation, attempt capping, exclusion
carry-over, budget termination, and the directive's relationship to 007's ladder.

## Phase 1 — design

- [data-model.md](data-model.md) — schema `diagnosis`: classification, ruleset, diagnosis versions,
  hypotheses, disconfirming searches, violations, precedents, affected components, missing evidence,
  directive, anomalies, isolated confidence, and the `fix_eligibility` view.
- [contracts/openapi.yaml](contracts/openapi.yaml) — the read surface, the audited human override,
  and the handoff payload.
- [contracts/events.md](contracts/events.md) — `DiagnosisCompleted` and the classification events
  002, 007, 010 and 011 consume.
- [quickstart.md](quickstart.md) — scenarios, weighted toward the ones that must fail.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Eligibility as a SQL view rather than a column | A column can be written; a view cannot. FR-002 requires a structural fact, and the cheapest structural fact is one with no write path | A boolean column maintained by application code is one careless `update` from permitting a patch on a Redis outage, and the wrongness is invisible |
| Confidence in a sibling table, not on `diagnosis` | FR-015 and SC-005 require structural exclusion. A separate table plus one boundary pattern is less machinery than a gate that parses policy predicates | Keeping it on the row makes exclusion a convention, and conventions are what constitution IV exists to replace |
| `precedent_candidate` has no conclusion column | FR-020 forbids citing a precedent's conclusion. Not representable beats forbidden — the same argument as 012's single-valued `fallback_scope` | A nullable `previous_root_cause` column would be populated "for the human" within one sprint and cited within two |
| Classification versions are rows, not a mutable record | FR-003 requires reversal only by a new run or an audited human override | Updating the verdict in place loses the fact that the system once said something else, which is the fact an incident review needs |
| A statement fingerprint on `hypothesis` | FR-024's exclusions must survive rewording, or re-diagnosis regenerates the refuted hypothesis in new words and the cap buys nothing | Exact-string exclusion is defeated by any paraphrase, which a second model run produces by default |
