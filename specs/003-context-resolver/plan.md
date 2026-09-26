# Implementation Plan: Context resolution across the hybrid boundary

**Branch**: `003-context-resolver` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

One immutable `ContextSnapshot` per issue, collected in parallel inside the customer's network,
redacted there, and crossing to the control plane only as the closed evidence shapes of
[012 contracts/runner-protocol.md](../012-engineering-foundation/contracts/runner-protocol.md).

This is the first genuinely distributed component (ADR 0001), and the split is not negotiable in
either direction: **what must be deterministic runs in the control plane, what must see customer
data runs in the execution plane.** Planning and ranking are central because they have to be
versioned, replayable and auditable by us; collection and redaction are local because the
credentials, the log bodies and the legal exposure are theirs.

Three commitments follow. **The plan is a pure function of the issue**, so the same issue produces
the same plan digest — and that digest is also the idempotency key, which is why FR-026 needs no
separate mechanism. **Nothing degrades silently**: every source that is not `collected` produces a
`collection_gap` evidence record, which is what makes 006's `INSUFFICIENT_CONTEXT` (006 FR-013)
persistable under 001 FR-009 instead of being a conclusion with no support. And **collected content
is data**, enforced twice — by a branded type the planner and ranker cannot accept, and by a
differential test that proves injected instructions change nothing (SC-010).

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`), Prisma 6, BullMQ, Zod (boundary schema,
collector parameter schemas, redaction ruleset), Pino, OpenTelemetry. Adapters for Grafana / Loki /
Prometheus / OpenTelemetry and GitLab — the constitution's v1 set, nothing beyond it

**Storage**: PostgreSQL — `context` schema in the control plane. Inside the execution plane: a
local, plane-resident withholding ledger and a bounded outbound buffer, and nothing else that
outlives a collection pass

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12); a seeded-marker corpus
for SC-001 and a differential injection corpus for SC-010

**Target Platform**: split. `packages/domain/context` runs in the control plane; the collector pool
and the redactor ship inside `apps/runner` (ADR 0001, C-01)

**Project Type**: domain package plus a runner module, over one shared boundary-schema package

**Performance Goals**: full-source collection wall-clock within 2× the slowest single source and
flat in source count (FR-003, SC-006); snapshot visible within 120 s of `IssueDetected`; ranking and
deduplication of 50 000 raw items under 5 s

**Constraints**: no raw log body, request payload, configuration value or secret crosses the
boundary in any form (FR-007); no control-plane credential for any customer system (FR-002); no job
waits for the runner (FR-025, ADR 0003)

**Scale/Scope**: 12 000 raw log lines collapsing to single figures of patterns; eight to twelve
configured sources per tenant; snapshots retained with their issue, evidence expiring sooner (001)

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every collected item is an `Evidence` record with the collection step as its producer (FR-012, 001 FR-008); every gap is itself an evidence record, so a degraded snapshot is a fact rather than a silence | ✅ |
| II. Anti-Circular Verification | Collection produces raw observation only. It forms no conclusion, so it cannot become an anchor for one; ranking never reads a downstream conclusion | ✅ |
| III. Reproduce Before Modify | Not exercised here; this feature supplies the evidence the classifier (006 FR-001) runs on, before any modify path opens | n/a |
| IV. Deterministic Control | The collection plan, deduplication and ranking are versioned deterministic rules with no model in the path (FR-004, FR-019) | ✅ |
| V. Dependency-Aware Change | Not exercised here; impact analysis is 008 | n/a |
| VI. Serialize / Parallelize | This is the parallel half of Principle VI: all sources concurrently, inside the runner; the control-plane wait is a persisted state plus the `runner_result` callback (FR-025, 012 FR-029) | ✅ |
| VII. Architecture Agnostic | Collectors resolve against `Component` (004); an unknown component degrades to the default scope and records the reduced precision rather than guessing a service name | ✅ |
| VIII. Simplicity | Dedup reuses 001's normalisation ruleset instead of a second normaliser; ranking is a weighted sum of named terms, not a learned model | ✅ |

**Boundary**: the closed crossing list is 012 FR-022 and `runner-protocol.md`. This feature conforms
to it and adds nothing to it; where 003 FR-006 names an item class with no shape in that contract,
the contract is the authority and the gap is a cross-spec item, not a local extension (R-03).

**Tenancy**: `tenant_id` on every table, in every query and on every collector invocation (FR-023,
012 FR-048). A cross-tenant snapshot, item or source reference returns not-found (SC-009).

**Security**: retrieved content is data, never instructions (FR-021, SC-010, constitution Security
Model). Collector credentials exist only in the execution plane (FR-002).

## Project Structure

### Documentation (this feature)

```text
specs/003-context-resolver/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml           # runner result ingress, snapshot reads, boundary rejections
    └── collection-plan.md     # plan directive, result batch, collector registry, gap reason codes
```

### Source code

```text
packages/domain/context/                 # control plane
├── domain/
│   ├── collection-plan.ts               # pure: (issue facts, ruleset) → RequestedPlan + digest
│   ├── collector-registry.ts            # declared collectors, parameter schemas, item classes
│   ├── ranking/                          # named weighted terms, integer scores, total order
│   ├── dedup.ts                          # keyed on 001's normalisation ruleset — not a second one
│   └── gap-reasons.ts                    # the closed reason-code set
├── application/
│   ├── commands/   # PlanCollection, DispatchPass, IngestResultBatch, RequestFollowUpPass,
│   │               # FinaliseSnapshot, QuarantineRejection
│   └── queries/    # GetLatestSnapshot, GetSnapshot, ListItems, GetCompleteness, ListRejections
├── infrastructure/ # Prisma repositories, ingress validator, outbox publisher
└── presentation/   # runner ingress controller, tenant read controller, DTOs

apps/runner/src/collection/              # execution plane
├── pool.ts                              # bounded concurrent fan-out, per-source timeout
├── collectors/                          # adapter instances bound to local credentials
├── redaction/                           # versioned detector set, applied before egress
├── withholding-ledger.ts                # plane-local; resolves a withheld item for a local human
└── egress.ts                            # boundary-schema validation before anything is sent

packages/boundary-contract/              # the schema both planes validate against (R-02)
packages/integrations/{loki,prometheus,grafana,otel,gitlab,config-flags}/
```

**Structure decision**: the boundary schema is **one package imported by both planes**, not a schema
in the control plane and a matching one in the runner. 012 FR-022 requires validation at egress on
the runner and independently at ingress on the control plane; two copies of a schema are two schemas
that will diverge, and the divergence appears as data crossing that one side believed was declared.
Independent validation means two *executions*, not two definitions.

`packages/boundary-contract` is not in the package list of 012 FR-001 and is recorded in Complexity
Tracking; 012 FR-001 is where the documented package set is kept current.

## Phase 0 — research

See [research.md](research.md): the plane split and what each side may decide, the shared boundary
schema, conformance to the runner protocol, the requested-versus-resolved plan, the plan digest as
idempotency key, parallelism inside the runner, gaps as evidence, the plane-local withholding
ledger, explainable ranking, deduplication reusing 001, untrusted content enforced by type, ingress
quarantine that stores no payload, and contradiction without resolution.

## Phase 1 — design

- [data-model.md](data-model.md) — `context_snapshot`, `context_item`, `collection_pass`,
  `source_outcome`, `collection_ruleset`, `ranking_ruleset`, `redaction_ruleset`,
  `collector_registration`, `boundary_rejection`, and the plane-local `withholding_ledger`.
- [contracts/collection-plan.md](contracts/collection-plan.md) — the directive and result shapes
  that ride inside 012's `collection_plan` and evidence envelopes, the collector registry and the
  closed gap reason codes.
- [contracts/openapi.yaml](contracts/openapi.yaml) — runner ingress and the tenant read surface.
- [quickstart.md](quickstart.md) — scenarios, including the ones that must be withheld, refused or
  quarantined.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| A `packages/boundary-contract` package outside 012 FR-001's list | Both planes must validate against the *same* definition; 012 FR-022 asks for two validations, not two schemas | A schema per plane drifts, and the drift shows up as a field one side thinks is declared and the other has never seen |
| Ranking terms stored per item, not just a score | FR-019 requires explainable, and "0.72" explains nothing; an engineer must be able to disagree with a weight rather than with a number | A bare score makes the ranking an invisible filter on the evidence the diagnosis ever sees |
| Integer scores with an explicit total order | Byte-identical ordering across runs (SC-007) — float summation order changes the low bits, and ties otherwise resolve by whatever order the database returned | "Sort by score" is non-deterministic the first time two items tie, and a non-deterministic evidence set makes the benchmark meaningless |
| A plane-local withholding ledger inside the runner | FR-009 and Story 1 scenario 5 require a withheld item to be resolvable by a human **inside** the customer's network; the control plane must not be able to resolve it | Sending a resolvable reference would make the withheld content reachable from our side, which is the thing withholding exists to prevent |
| A separate collection pass per follow-up request | FR-005 caps and attributes them; folding them into the original snapshot would lose the requester and the reason | One growing snapshot makes "who asked for this and why" unanswerable and breaks FR-022's immutability |
| Rejected inbound payloads stored as a digest and schema errors, never as content | A payload that failed boundary validation is precisely the one that may contain what must not be stored (FR-010) | Storing the payload "for debugging" defeats the boundary at the exact moment it was doing its job |
