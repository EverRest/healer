# Implementation Plan: Engineering foundation

**Branch**: `012-engineering-foundation` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

The monorepo, the gates that enforce the constitution mechanically, the runner as a shipped
product, and the machinery every other spec assumes exists: workflow execution, prompt registry,
configuration, self-observation, storage conventions — and the controls that let a coding agent
implement tasks under the same gates as a human (US10).

Two ideas shape the approach. First, **a rule that is not a gate is a suggestion** — module
boundaries, tenant isolation, undo coverage and the never-wait-in-a-job rule are enforced by
checks that fail the build, not by review. Second, **build it once**: the agent run record is the
single store of the agent-run facts that 001's audit entry resolves through (001 FR-012, C-13), and
the persisted workflow transitions are the machine-step half of 001's timeline, unioned with its
domain events rather than duplicating them (001 FR-013, C-14). A second store of either set of facts
would immediately disagree with the first.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`, `@nestjs/swagger`, `@nestjs/bullmq`,
`@nestjs/throttler`), Prisma 6 (multi-schema, pgvector), BullMQ, Pino, OpenTelemetry SDK,
Zod (structured-output and event schemas), ts-morph (code intelligence, 008)

**Storage**: PostgreSQL 17 — source of truth, graphs via recursive CTE, pgvector as a secondary
index (ADR 0004). Redis for queues, locks, rate limiting and transient state only

**Testing**: Vitest (unit), Supertest (e2e against a disposable database), Testcontainers for
Postgres and Redis

**Target Platform**: Linux containers. Control plane on our infrastructure; runner in the
customer's (ADR 0001)

**Project Type**: monorepo — several apps over shared packages

**Performance Goals**: `make ci` under 10 minutes on a cold cache; a single agent run's overhead
outside model latency under 500 ms

**Constraints**: no job may run longer than its declared wall-clock limit (ADR 0003); no secret,
customer source or customer log body in any log, trace or evidence record

**Scale/Scope**: first year — tens of tenants, hundreds of components per tenant, thousands of
issues per tenant per month

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | The agent run record is the single store of the agent-run facts 001's audit entry resolves through (FR-033, C-13); no second store of those facts permitted | ✅ |
| II. Anti-Circular Verification | Prompt registry makes `promptVersion` immutable and resolvable, so a past decision can be reconstructed rather than re-narrated. An agent-authored change set cannot weaken a pre-existing test or edit the gates that judge it (FR-055) | ✅ |
| III. Reproduce Before Modify | Not exercised by this feature; the sandbox it packages is specified in 007 | n/a |
| IV. Deterministic Control | `make ci` is the single gate entry point and fails closed when a change set is not inspectable | ✅ |
| V. Dependency-Aware Change | Module boundaries enforced by **pattern**, so a new module cannot silently escape them | ✅ |
| VI. Serialize / Parallelize | "Never wait inside a job" enforced twice: a static check and a runtime wall-clock limit | ✅ |
| VII. Architecture Agnostic | The runner ships as an image plus one wrapper; adapters are packages, not branches in core | ✅ |
| VIII. Simplicity | Docker Compose only for local development; no Terraform, no Kubernetes for our own deployment in v1 | ✅ |

**Security model**: per-tenant provider configuration exists from day one (FR-042..046) and
fallback across provider boundaries is forbidden (FR-046) — an ordinary retry would route a BYO
tenant's source to our provider and break the contract that made them adoptable.

## Project Structure

### Documentation (this feature)

```text
specs/012-engineering-foundation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── make-targets.md       # the gate contract — what each target must do
│   └── runner-protocol.md    # control plane ↔ runner: capabilities, evidence, versioning
└── tasks.md                  # /speckit-tasks output, not created here
```

### Source code (repository root)

```text
apps/
├── api/                     # NestJS HTTP + webhooks, control plane
├── worker/                  # BullMQ consumers, same code, separate process
├── mcp-server/              # outward MCP surface (ADR 0005)
├── runner/                  # ships to the customer's execution plane (ADR 0001)
└── dashboard/               # human review surface

packages/
├── domain/
│   ├── issues/              # 001
│   ├── evidence/            # 001 — its own domain, not part of knowledge
│   ├── policy/              # 002
│   ├── context/             # 003
│   ├── architecture/        # 004
│   ├── knowledge/           # 005
│   ├── diagnosis/           # 006
│   ├── reproduction/        # 007
│   ├── change/              # 008
│   ├── support/             # 009
│   ├── remediation/         # 010
│   └── evaluation/          # 011
├── agents/                  # investigator, change, verifier — prompts + structured output
├── llm/                     # provider-agnostic interface + adapters, per-tenant config
├── code-intelligence/       # AST, call graph, impact analysis (ts-morph)
├── integrations/            # gitlab, grafana, loki, prometheus, otel — adapters only
├── prompts/                 # versioned, immutable prompt registry
├── events/                  # domain events, outbox, schemas
├── sandbox/                 # isolation, limits, test-runner adapters
├── workflow/                # state machine, callbacks, never-wait enforcement
├── boundary-contract/       # the closed crossing schema set (contracts/runner-protocol.md)
└── shared/                  # config, logging, tracing, tenancy, errors

prisma/                      # schema, migrations, seeds
scripts/                     # gate scripts invoked by make, incl. gate-agent-scope, gate-red-first
docker/                      # compose for local development
```

**Structure decision**: one repository, several processes from the same code. The runner is an
app rather than a package because it is versioned, released and upgraded on its own cadence —
the customer's upgrade is not our deploy.

## Phase 0 — research

See [research.md](research.md). Resolves: gate mechanics, how "never wait inside a job" is
detected statically, runner protocol versioning, prompt immutability, per-tenant provider
configuration, what makes the runner debuggable without seeing customer data, and agent-driven
development: who counts as an agent (R-13), red-first (R-14), protected tests (R-15), where agents run
and what holds their merge rights and budgets (R-16).

## Phase 1 — design

- [data-model.md](data-model.md) — the tables this feature owns: workflow state, prompt versions,
  tenant configuration, runner registrations. The domain tables belong to their own specs.
- [contracts/make-targets.md](contracts/make-targets.md) — the gate contract.
- [contracts/runner-protocol.md](contracts/runner-protocol.md) — the boundary contract, which is
  also the document a customer's security review reads.
- [quickstart.md](quickstart.md) — checkout to green tests, and the scenarios that prove each gate
  actually fails when it should.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Runner as a separately versioned app | It runs in someone else's infrastructure and upgrades on their schedule (ADR 0001) | Shipping it with the control plane would make every release of ours a forced upgrade at every customer |
| Prompt registry as immutable storage rather than files in git | An audit entry from a year ago must resolve to the exact prompt text; git history alone cannot guarantee a prompt was not rewritten in place | Reading prompts from the repository at runtime makes `promptVersion` a claim rather than a fact |
| Two enforcement mechanisms for "never wait inside a job" | A static check catches the obvious cases; a runtime wall-clock limit catches the creative ones | Either alone leaves the trap open, and the cost of the trap is a forced Temporal migration later (ADR 0003) |
