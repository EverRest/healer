# Implementation Plan: Knowledge sources, provenance and expected behaviour

**Branch**: `005-knowledge-and-expected-behavior` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

One retrieval surface over everything a customer has written, ranked by a hierarchy that inverts
with the question — and `ExpectedBehavior` as the human-owned anchor that makes Principle II true
rather than aspirational.

Three commitments. **Anchor eligibility is a row, not a state check**: adoption writes an
`anchor_grant`, and 008 references *that*, so an unadopted expectation is not something the
verification path rejects — it is something the verification path cannot name. **The only text
adapter in v1 is repository markdown** (C-06), which is not a reduction in ambition: git supplies
freshness and authorship for nothing, and adoption travels through merge request approval, so the
human adoption gate is a process the customer already runs and already audits. And **a retrieval
request without a declared question type does not exist**: there is no `rank(query)` function with a
default, only `rankCurrentBehavior` and `rankIntendedBehavior`, dispatched from a required
discriminator.

Adoption does not expire. No scheduled job may write to an anchor grant — a stale anchor is
surfaced by freshness and drift and revoked by a person, because an anchor that expires on its own
makes a verification result depend on the clock.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`), Prisma 6 (multi-schema), BullMQ, Zod
(document and constraint schemas), `gray-matter`-style front-matter parsing over the repository
markdown adapter, Pino, OpenTelemetry

**Storage**: PostgreSQL 17, schema `knowledge`. Three retrieval paths — structural (identity
joins), lexical (`tsvector` + GIN), vector (pgvector). Vector is a secondary index and droppable
(ADR 0004, D-05). `pg_trgm` for deterministic near-duplicate detection

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12); a disagreement corpus
where wiki, code and observation contradict each other (SC-006); every retrieval suite runs twice —
once with the vector index dropped (SC-004)

**Target Platform**: control plane. Documents arrive through the runner as bounded excerpts under
the boundary contract (003 FR-006, 003 FR-011); adoption arrives as a GitLab merge event

**Project Type**: domain package `packages/domain/knowledge`, adapters in `packages/integrations/*`

**Performance Goals**: retrieval p95 under 400 ms over a 50 000-section corpus with the vector path
enabled, and under 250 ms with it disabled; constraint lookup by name under 10 ms with 0 model calls

**Constraints**: no anchor without an adoption record naming a human; no automatic publish to a
customer system; no cross-tenant candidate ever entering a ranking, including inside an ANN scan

**Scale/Scope**: tens of thousands of document sections per tenant, hundreds of expectations,
thousands of adoption and revocation events over a year

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | A retrieval result supporting a conclusion becomes a `document_excerpt` evidence record emitted by the retrieving step (FR-025, 001 FR-007, 001 FR-008) | ✅ |
| II. Anti-Circular Verification | This feature *is* Principle II's mechanism: only an `anchor_grant` written by a human adoption is referenceable as an anchor (FR-010, FR-011, SC-001) | ✅ |
| III. Reproduce Before Modify | Not exercised here | n/a |
| IV. Deterministic Control | Ranking is versioned rules over stored tiers with a total order; constraints resolve by name and type with no model in the path (FR-014, SC-010) | ✅ |
| V. Dependency-Aware Change | Expectations and constraints attach to a `Component` and `Feature` from 004, so a change's expectations follow its impact set | ✅ |
| VI. Serialize / Parallelize | Source sync and seeding are parallel per source; adoption is a serialised transaction that writes the grant | ✅ |
| VII. Architecture Agnostic | A document attaches to a `Component` (004), never to a service name; source adapters hold the only source-specific logic | ✅ |
| VIII. Simplicity | Retrieval works with the vector index dropped; near-duplicate detection is core Postgres, not a model | ✅ |

**Trust hierarchy**: the constitution's two orderings are stored as `trust_tier_rule` rows, versioned,
one rule set per question type. A ranking result names the rule and version that placed it (FR-006).

**Untrusted input**: every document body, front-matter value, merge request description and commit
message is data. It reaches no policy predicate, no tool selection, no autonomy grant and no ranking
rule (FR-026). The ranking input is the document's *metadata* — source class, provenance, freshness
— never its text.

## Project Structure

### Documentation (this feature)

```text
specs/005-knowledge-and-expected-behavior/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml           # retrieval, expectations, adoption, constraints, seeding, drift
    └── retrieval-contract.md  # question-type dispatch, trust tiers, the anchor resolution
                               # surface 008 uses, and the repository markdown format
```

### Source code

```text
packages/domain/knowledge/
├── domain/           # KnowledgeSource, KnowledgeDocument, DocumentVersion, ExpectedBehavior,
│                     # AnchorGrant, Constraint, trust tiers, question types
├── application/
│   ├── commands/     # SyncSource, IngestDocumentVersion, SeedExpectations, ProposeDraft,
│   │                 # RecordAdoption, RevokeAdoption, RaiseKnowledgeDrift, ResolveKnowledgeDrift
│   └── queries/      # RetrieveCurrentBehavior, RetrieveIntendedBehavior, ResolveAnchor,
│                     # ResolveConstraint, GetFreshness, GetSeedingMetrics
├── infrastructure/   # Prisma repositories, the three retrieval paths, tenant-partitioned
│                     # embeddings, pg_trgm duplicate detection
└── presentation/     # controllers, DTOs

packages/integrations/
├── gitlab/           # repository markdown, git history, merge requests, issues — the v1 adapter
└── openapi/          # OpenAPI descriptions and e2e test names, for seeding
```

**Structure decision**: `ExpectedBehavior` lives in `knowledge` rather than in its own package, and
`AnchorGrant` lives beside it. Splitting them would put the adoption transaction across a package
boundary, and the whole safety argument rests on adoption and grant being one transaction. Evidence
stays in 001's package: a knowledge citation *becomes* evidence, it is not a second kind of it.

## Phase 0 — research

See [research.md](research.md): the anchor grant and why it is a row, adoption through merge request
approval and the one identity that must not be able to approve, question-type dispatch without a
default, versioned trust tiers and a total ordering, tenant-partitioned embeddings, constraint
conflicts counted rather than ranked, freshness that never touches anchor state, near-duplicate
detection without a model, and how the repository markdown format carries both prose and structured
constraints.

## Phase 1 — design

- [data-model.md](data-model.md) — `knowledge_source`, `knowledge_document`, `document_version`,
  `document_section`, `section_embedding`, `expected_behavior`, `expected_behavior_version`,
  `anchor_grant`, `adoption_record`, `knowledge_constraint`, `trust_tier_rule`, `retrieval_query`,
  `retrieval_result`, `knowledge_drift_finding`, `seeding_session`, `duplicate_group`. Issues,
  evidence and audit belong to 001; components and features to 004.
- [contracts/openapi.yaml](contracts/openapi.yaml) — the retrieval and adoption surface.
- [contracts/retrieval-contract.md](contracts/retrieval-contract.md) — the in-process surface 006,
  008 and 009 program against, and the document format a customer's repository holds.
- [quickstart.md](quickstart.md) — scenarios, including the ones that must fail.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| `anchor_grant` as a table rather than a state check on `expected_behavior` | 008 must reference the grant, so an unadopted entry is unnameable rather than rejected | `WHERE state = 'adopted'` is a predicate someone can omit in a new query, and the omission produces a passing verification |
| `section_embedding` partitioned by tenant | An ANN scan over a global index with a tenant filter is post-filtering, which FR-027 forbids and which silently loses recall for small tenants | A shared index with a `WHERE tenant_id` is simpler and can return zero rows for a tenant whose documents never enter a global top-k |
| Three retrieval paths rather than vector alone | ADR 0004 makes pgvector a secondary index; SC-004 requires retrieval with it dropped | Vector-only retrieval makes an index the source of truth, and an index that cannot be rebuilt from source is a second database |
| Two ranking functions, no shared entry point | FR-004 refuses an undeclared question type, and a default parameter is a declaration nobody made | One `rank(query, type = 'current')` puts the wrong ordering one omitted argument away |
| `pg_trgm` for near-duplicate detection | Deterministic, no model, works with the vector index dropped | A model or an embedding threshold makes duplicate grouping non-reproducible and dependent on the index SC-004 says must be optional. Requires a one-line extension entry in ADR 0004 (R-10) |
