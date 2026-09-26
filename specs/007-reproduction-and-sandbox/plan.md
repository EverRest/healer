# Implementation Plan: Reproduction engine and isolated execution

**Branch**: `007-reproduction-and-sandbox` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

A reproduction directive from 006 becomes a climb up six ordered rungs in a sandbox inside the
customer's network, stopping at the first rung that reproduces the issue — or an `INCONCLUSIVE`
that reaches a human with every rung attempted, its cost and its reason.

Four commitments shape the design. **The rung vocabulary is frozen here** (`unit`, `request`,
`data`, `concurrency`, `load`, `external_state`) as ordered reference data, because it is the
contract between 006's directive and this engine and two copies of it would drift on the first
change. **A `FAIL` is a signature equality, not a resemblance**: the observed failure is normalised
by the *same* 001 ruleset version the issue recorded, and anything else is `INCONCLUSIVE` plus a
possible-second-defect finding — a different failure is never counted as a reproduction.
**There is no fixture store** (C-04): `reproduction_fixture` has no contents column, the workspace
is a tmpfs inside the run container and dies with it, and what reaches 008 is the *recipe* — field
shapes and the failing constraint — never the data. And **the run container has no default route
at all**: dependencies are fetched in a separate prefetch container against a registry-only
allowlist, so default-deny is a property of the network namespace rather than a filter that can be
misconfigured.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`, `@nestjs/bullmq`), Prisma 6, BullMQ, Zod
(result and directive schemas), Pino, OpenTelemetry. Container runtime and isolation are packaged by
the runner (012 FR-017); no new runtime dependency is introduced by this feature

**Storage**: PostgreSQL — schema `reproduction`. Control plane holds records; the execution plane
holds no durable state beyond the in-flight run

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12). A hostile fixture suite
— egress, credential probe, fork bomb, hang, shared-path write — runs in `make ci` and must be seen
to be denied (SC-003, SC-004)

**Target Platform**: split. The engine, ladder state and results are control plane; the sandbox,
checkout, test execution and fixture construction are execution plane (ADR 0001). Only the structured
result contract crosses (012 FR-022, FR-023)

**Project Type**: domain package `packages/domain/reproduction` (control plane) plus
`packages/sandbox` and its adapters, shipped inside `apps/runner`

**Performance Goals**: sandbox start to first test byte under 10 s with a warm dependency cache;
the `unit` rung under 90 s p95 end to end; no worker job over 60 s (012 FR-027) — the ladder is a
sequence of short jobs against persisted state, never one long one

**Constraints**: default-deny egress with no route in the run container; no production credential,
repository write credential or tenant secret present, checked before and after every run; workspace
destroyed on every exit path including timeout and crash; no agent holds a shell

**Scale/Scope**: concurrent runs bounded per tenant by the runner's declared `maxConcurrentRuns`
(012 runner protocol); queue depth is observable state, not a blocked job

## Constitution Check

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every rung attempt, egress denial, test result and resource reading is an evidence record emitted by the run as it executes (FR-029, 001 FR-008) | ✅ |
| II. Anti-Circular Verification | The reproduction assertion derives from the issue's normalised signature, the violated contract or an adopted expectation — never from the diagnosis narrative (FR-008, R-02). Execution is the first evidence that is not a model's output | ✅ |
| III. Reproduce Before Modify | This feature *is* Principle III. `change_eligibility` is a view returning true only for a recorded `FAIL` (R-16); `INCONCLUSIVE` is first-class and routes to a human (R-05) | ✅ |
| IV. Deterministic Control | Signature matching is an equality over a versioned normalisation, not a similarity score. No model participates in deciding `PASS`/`FAIL`/`INCONCLUSIVE` | ✅ |
| V. Dependency-Aware Change | Not exercised here; 008 owns impact. This feature reports which tests the reproduction touched | n/a |
| VI. Serialize / Parallelize | The ladder is a persisted state machine of short jobs (012 FR-029); CI delegation is a callback, never a wait (ADR 0003, R-11); queued runs hold no worker | ✅ |
| VII. Architecture Agnostic | Rungs are defined by what they need, not by a stack. Test-runner knowledge lives only in adapters (R-10) | ✅ |
| VIII. Simplicity | Workspace destruction is container exit, not cleanup code. The fixture "store" is the absence of one | ✅ |

**Security** (`security-posture.md`): the sandbox runs model-generated code and a test suite whose
inputs are attacker-influenceable, over the customer's source tree. Egress denial matters more in
practice than container escape, so it is structural (R-08) rather than configured. Agents request
execution through two declared, schema-validated tools and never a shell (FR-028, R-15). The sandbox
has no path to the control plane except the structured result contract, and holds no capability
object of any kind — execution is deliberately outside ADR 0008's scope because its effects die with
the workspace, while the irreversible downstream operation, the repository write, is 008's.

**Tenancy**: every execution, workspace, cache, image tag and fixture record carries `tenantId`; no
writable state is shared across tenants, and the dependency cache is per tenant even when the
contents would be identical (FR-030, R-09).

## Project Structure

### Documentation (this feature)

```text
specs/007-reproduction-and-sandbox/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── ladder.md               # the frozen rung vocabulary, directive and result — the 006↔007 contract
    ├── test-runner-adapter.md  # what a new stack's adapter must implement
    ├── events.md               # ReproductionCompleted, CiResultsReceived — what 008 consumes
    └── openapi.yaml            # CI callback, reproduction reads, change eligibility
```

### Source code

```text
packages/domain/reproduction/           # control plane
├── domain/
│   ├── ladder/            # rung order, climb rule, stop rule, skip reasons
│   ├── matching/          # signature equality over the issue's ruleset version
│   ├── intermittency/     # repeat policy per rung class, observed rate
│   └── outcome/           # PASS | FAIL | INCONCLUSIVE and the closed reason set
├── application/
│   ├── commands/          # StartReproduction, AdvanceRung, RecordRunResult, DelegateToCi, IngestCiResult
│   └── queries/           # GetAttempt, GetLadderRecord, GetChangeEligibility, GetHandoff
├── infrastructure/        # Prisma repositories, directive dispatch to the runner
└── presentation/          # controllers, DTOs, the CI callback endpoint

packages/sandbox/                        # ships inside apps/runner (execution plane)
├── isolation/             # namespaces, limits, egress posture, credential scan
├── workspace/             # checkout, prefetch, tmpfs lifecycle
├── fixtures/              # request-shape, synthetic, anonymised — construction only, no store
├── adapters/              # test-runner discovery, invocation, machine-readable report parsing
└── protocol/              # the structured result contract; the only way out
```

**Structure decision**: `packages/sandbox` is separate from `packages/domain/reproduction` because
they run in different planes and are trusted differently. The domain package decides which rung to
attempt and what a result means; the sandbox package executes and knows nothing about issues,
diagnoses or ladders. Merging them would put ladder logic inside the customer's network, where it
would be upgraded on the customer's schedule (012 FR-017) rather than ours — and the stop rule is
something we need to be able to change in an afternoon.

Fixture construction sits in the sandbox, not the control plane, for the same reason the redactor
does (ADR 0001): a fixture derived from a production row must never be built somewhere the row
would have to travel to.

## Phase 0 — research

See [research.md](research.md). Resolves: the frozen rung vocabulary, signature equality and its one
deliberate relaxation, the repeat policy and what intermittency means downstream, the closed
`INCONCLUSIVE` reason set, C-04 without a fixture store and what reaches 008 instead, workspace
destruction by container exit, egress as an absent route, credential scanning, test-runner adapters
that never parse prose, CI delegation, capacity queuing, retry identity, environment
reconstructibility, no-shell execution, and the change-eligibility view.

## Phase 1 — design

- [data-model.md](data-model.md) — schema `reproduction`: rung reference data, attempts, rung
  attempts, execution runs, sandbox profiles, egress denials, test results, adapter resolutions,
  fixture metadata, CI delegations, separate-defect findings, and the `change_eligibility` view.
- [contracts/ladder.md](contracts/ladder.md) — the frozen vocabulary and the directive and result
  shapes. Normative; 006 imports it.
- [contracts/test-runner-adapter.md](contracts/test-runner-adapter.md) — discovery, invocation and
  parsing, and the rule that an adapter unable to request a machine-readable report is unsupported.
- [contracts/events.md](contracts/events.md) — `ReproductionCompleted` and `CiResultsReceived`, the
  two events 008 consumes, plus the escalation and finding events 009 and 011 read.
- [contracts/openapi.yaml](contracts/openapi.yaml) — the CI callback and the read surface.
- [quickstart.md](quickstart.md) — scenarios, heavily weighted toward the hostile ones.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Two packages across the plane boundary | Ladder decisions must upgrade on our cadence; execution must run on theirs (ADR 0001, 012 FR-017) | One package means the stop rule ships inside the customer's network and changes only when they upgrade |
| `reproduction_fixture` has no contents column | C-04 is decided. Not representable beats forbidden | A nullable `contents` column becomes derived customer data at rest, a DPA clause, and a retention policy — for a value that is destroyed with the workspace anyway |
| Prefetch container separate from the run container | Default-deny is only real if the run container has no route; a package install needs one (R-08) | A single container with an egress allowlist makes exfiltration one misconfigured CIDR away, and the misconfiguration is silent |
| A closed `inconclusive_reason` set alongside the three-value result | "Inconclusive" alone tells a human nothing, and each of the ten reasons has a different next action (R-05) | A free-text reason cannot be reconciled, measured (SC-006) or routed |
| Adapters request a machine-readable report rather than parsing stdout | Every unparseable output that degrades to "looks fine" is a false `PASS`, the most expensive lie the system can tell (R-10) | Regex over human output works for three runners and fails silently on the fourth, in the direction that opens the change path |
| Per-tenant dependency cache even for identical contents | A shared writable cache is a cross-tenant write channel disguised as an optimisation (FR-030) | Deduplicating saves disk and costs the isolation property the sandbox exists for |
