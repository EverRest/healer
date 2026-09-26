# Implementation Plan: Issue lifecycle and evidence substrate

**Branch**: `001-issue-and-evidence` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

One `Issue` aggregate for every source, one investigation pipeline up to the decision point, and an
immutable `Evidence` record behind every claim the system makes.

Two design commitments drive everything else. **Evidence is a substrate, not a feature** — the
timeline, the audit trail and the evidence graph are three queries over one dataset, so they cannot
disagree, and the postmortem draft and change correlation named by the constitution are two later
surfaces over the same records rather than deliverables here (FR-013). And **a link is written by the
step that made it**, as it runs; nothing in this system reconstructs a reason afterwards, because a
reconstructed reason is a story rather than a record.

Deduplication is the unglamorous part that everything else depends on: without it every downstream
cost multiplies by the duplication factor, and the product is unusable at the first real incident.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`), Prisma 6, BullMQ, Zod (event and evidence
schemas), Pino, OpenTelemetry

**Storage**: PostgreSQL — `issue`, `evidence`, `audit` schemas. Append-only tables enforced by
database rules, not by application discipline

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12)

**Target Platform**: control plane (ADR 0001). Evidence arrives from the runner as structured
shapes; this feature does not collect it — 003 does

**Project Type**: domain packages `packages/domain/issues` and `packages/domain/evidence`

**Performance Goals**: ingest 5 000 signals/minute per tenant with fingerprinting; issue visible
within 10 s of provider delivery; timeline render under 200 ms p95 for an issue with 10 000
evidence records

**Constraints**: no evidence mutation after write; no claim persisted without a reference; every
read constrained by `tenantId`

**Scale/Scope**: 10 000+ signals collapsing to one issue; issues retained longer than the evidence
behind them

## Constitution Check

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | This feature *is* Principle I: append-only records, producer-attributed links, no conclusion without a reference (FR-007..013) | ✅ |
| II. Anti-Circular Verification | Provides the substrate anchors are checked against; the producing-step attribution is what makes circularity detectable later | ✅ |
| III. Reproduce Before Modify | Not exercised here | n/a |
| IV. Deterministic Control | Fingerprinting, timeline and graph views are deterministic; no model participates in any of them | ✅ |
| V. Dependency-Aware Change | Not exercised here | n/a |
| VI. Serialize / Parallelize | Issue state is a persisted machine (012); transitions publish through the outbox so a rolled-back transition is never observed | ✅ |
| VII. Architecture Agnostic | An issue references a `Component` (004) and never a service name | ✅ |
| VIII. Simplicity | The timeline is a query, not an AI feature | ✅ |

**Tenancy**: `tenantId` on every table and in every query (012 FR-047..049). Cross-tenant read
returns not-found, never forbidden — forbidden confirms existence.

## Project Structure

### Documentation (this feature)

```text
specs/001-issue-and-evidence/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml    # ingestion, issue reads, views
    └── events.md       # domain events published through the outbox
```

### Source code

```text
packages/domain/issues/
├── domain/           # Issue, IssueEvent, state machine, fingerprint rules
├── application/
│   ├── commands/     # IngestSignal, TransitionIssue, MergeIssues, UnmergeIssues, DeleteIssue
│   └── queries/      # GetIssue, ListIssues, GetTimeline, GetEvidenceGraph, GetAuditTrail
├── infrastructure/   # Prisma repositories, outbox publisher
└── presentation/     # controllers, DTOs

packages/domain/evidence/
├── domain/           # Evidence, EvidenceLink, reference state
├── application/      # RecordEvidence, AttachLink, DetachEvidence, PurgeExpired
└── infrastructure/   # append-only repository, excerpt bounding
```

**Structure decision**: `evidence` is its own package rather than a folder inside `issues`.
Evidence outlives the investigation that produced it, is consumed by 006, 008, 009 and 011, and
has a different mutability contract. Nesting it under `issues` would invite a foreign key in the
wrong direction the first time something else needed it.

## Phase 0 — research

See [research.md](research.md): fingerprint normalisation and its versioning, reopen semantics,
append-only enforcement, detachment on source loss, excerpt bounding, merge and unmerge, deletion
under retention, and how views stay deterministic.

## Phase 1 — design

- [data-model.md](data-model.md) — `issue`, `issue_relationship`, `issue_event`, `evidence`,
  `evidence_link`, `audit_entry`, `normalisation_ruleset`, `ingestion_delivery`.
- [contracts/openapi.yaml](contracts/openapi.yaml) — ingestion and read surface.
- [contracts/events.md](contracts/events.md) — the domain events other features subscribe to.
- [quickstart.md](quickstart.md) — scenarios, including the ones that must fail.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Separate `evidence` package | Different lifetime, different mutability, four downstream consumers | Nesting under `issues` puts the dependency the wrong way round as soon as 011 reads evidence without an issue in scope |
| Append-only enforced at the database level | Application-level discipline degrades under deadline, and this is a non-negotiable principle | A repository that "does not expose update" is one careless method away from being wrong |
| `normalisation_ruleset` versioned as data | A fingerprint must be explicable a year later and recomputable | Hard-coding rules makes old fingerprints unexplainable after the first rule change |
| Merge is reversible | Two issues judged the same are sometimes not | An irreversible merge loses the distinction permanently and there is no way back |
