# Implementation Plan: Reversible production actions

**Branch**: `010-safe-remediation` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

Six actions, each declaring a precondition, an action, a verification and an undo, executed by the
runner inside the customer's infrastructure under a policy decision, verified against a signal that
existed before the incident, and undone automatically when the expected improvement does not appear.

Two commitments shape the design. **The catalogue is code, not configuration** — a new action is a
spec change and a release, because the thing that makes an action safe is a demonstrated undo, and
a configuration row cannot demonstrate anything. And **the undo is captured as data before the
mutation runs**, never derived afterwards from the observed state: the moment an undo is most needed
is the moment the target is least readable, and an undo computed from a broken system is a second
outage.

This is also where v1's measurable time saving comes from (D-19a). Rollback is reversible by
construction, verifiable in minutes against an error-rate baseline that pre-dates the deploy, and
bounded when wrong — which is why it may be autonomous while patching may not.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`), Prisma 6, BullMQ, Zod (action parameter,
directive and result schemas), Pino, OpenTelemetry. Platform access is through ports —
deployment, workload, feature flag, queue, job — whose concrete adapter set is confirmed by S0-4
and is not chosen here

**Storage**: PostgreSQL — schema `remediation`. Evidence, audit and issue state stay in 001;
policy decisions in 002; workflow state and callbacks in 012

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12); one undo test per
catalogue action, enumerated and enforced by `gate-undo` (012 FR-014)

**Target Platform**: split. The decision and the record are control plane; every mutation is
executed by the runner in the customer's execution plane (ADR 0001) through the
`remediation_directive` shape of the runner protocol

**Project Type**: domain package `packages/domain/remediation` plus the action modules shipped
inside `apps/runner`

**Performance Goals**: dispatch to execution acknowledgement under 30 s; default verification
window 10 minutes for a rollback, configurable per action and tenant; the headline measure is
time from issue creation to verified remediation (D-19a), reported by 011 SC-010

**Constraints**: no forward deploy is expressible; no shell path exists; no two mutations run
against one target concurrently; no action executes without a recorded policy decision

**Scale/Scope**: six catalogue actions in v1; tens of eligible targets per tenant; remediation is
rare by design — a target needing it often is an escalation, not a workload

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | State before, state after and every verification observation are evidence records emitted by the step that observed them (001 FR-007, FR-008); an action references the diagnosis or correlation evidence that justifies it (FR-018) | ✅ |
| II. Anti-Circular Verification | A verification anchor must pre-date the issue, and the anchor kinds are a closed enum with no member naming the action's own report (R-03) | ✅ |
| III. Reproduce Before Modify | Not exercised — a remediation changes no code. Its counterpart is that a remediation never closes a code problem (FR-017, R-11) | n/a |
| IV. Deterministic Control | Preconditions, blast-radius limits, cooldowns and caps are deterministic predicates; the model proposes an action key and parameters and decides nothing (R-01) | ✅ |
| V. Dependency-Aware Change | Blast radius is declared per action and resolved against the architecture graph (004 FR-015); an unconfirmed edge may only widen it (004 FR-016a, C-03) | ✅ |
| VI. Serialize / Parallelize | Mutations against one target are serialised by a database constraint, not a lock convention (R-07); the verification window is persisted state plus a `verification_tick` callback (012 FR-025) | ✅ |
| VII. Architecture Agnostic | A target resolves to a `Component` and a `DeploymentUnit` (004), never to a service name; platform specifics live in adapters | ✅ |
| VIII. Simplicity | Remediation history is a query over attempts, not a second table; verification observations are evidence, not a private log | ✅ |

**Autonomy**: this is the only autonomous production action class in year one (D-14). The L2
ceiling forbids **forward** deploys; rollback to a previously deployed version is a reversible
remediation governed by 002 FR-009 and FR-010 rather than by the ceiling (002 FR-008). R-04 makes
that distinction structural rather than a matter of intent.

**Capability passing** ([ADR 0008](../../docs/adr/0008-capability-passing.md), accepted): remediation
dispatch is one of the four irreversible operations in scope, so `DispatchAction` takes a
`RemediationDispatchCapability` as an argument and can resolve one from no container, module import,
ambient configuration or global (FR-009). That is what makes 011 FR-004 true over this feature — a
simulation run's bundle holds none of the four, so the dispatch path is unreachable rather than
uncalled — and it is why the no-shell property (SC-006) does not have to be re-argued at every call
site: a reviewer answers "can this path mutate production?" from the signature.

**Limits are 002's** (C-11): rate limits, cooldowns and attempt caps are evaluated inside the policy
decision over the `targetRef` and `fingerprint` this feature supplies, and reach a tenant here only as
projected refusal reason codes. Principle IV puts every limit in the one deterministic engine that
already writes a trace.

**Tenancy**: every catalogue binding, eligibility entry, attempt and block carries `tenantId`; dispatch
resolves the target within the tenant, so a foreign target is not addressable rather than being
filtered out afterwards (FR-024, 012 FR-048).

## Project Structure

### Documentation (this feature)

```text
specs/010-safe-remediation/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml           # catalogue, dry-run, proposals, attempts, eligibility, blocks
    ├── action-catalogue.md    # the six actions' four declarations, and the directive shape
    └── events.md              # domain events published and consumed
```

### Source code

```text
packages/domain/remediation/
├── domain/
│   ├── catalogue/       # the six action definitions — precondition, action, verification, undo
│   ├── bounds.ts        # blast radius and verification window — rate, cooldown and cap are 002's
│   └── block.ts         # target block state and who may clear it
├── application/
│   ├── commands/        # ProposeRemediation, DryRunRemediation, DispatchAction,
│   │                    # RecordActionResult, EvaluateVerificationTick, DispatchUndo,
│   │                    # RecordUndoResult, BlockTarget, ClearTargetBlock, SetTargetEligibility
│   └── queries/         # GetCatalogue, GetAttempt, ListAttempts, GetRemediationHistory,
│                        # ListTargetBlocks
├── infrastructure/      # Prisma repositories, directive dispatch, platform ports
└── presentation/        # controllers, DTOs

apps/runner/actions/     # executing side: one module per catalogue key, exporting plan() and apply()
packages/integrations/   # deployment, workload, flag, queue and job adapters behind those ports
```

**Structure decision**: the catalogue definition lives in the control plane and the *execution* of
each action lives in the runner, and the two are separate modules bound by the action key and its
parameter schema. Putting the executor in the control plane would require production credentials
there; putting the definition in the runner would let a customer's deployment decide what counts as
reversible. The key set is a TypeScript union, so an action the catalogue does not declare cannot be
named by either side.

## Phase 0 — research

See [research.md](research.md): why the catalogue is code, how the undo test becomes an admission
gate rather than a checklist item, how a verification anchor is prevented from pointing at the
action's own output, why a forward deploy is not expressible, where the undo plan is captured, how
recurrence is counted when each recurrence creates a new issue, and what happens after an undo
fails.

## Phase 1 — design

- [data-model.md](data-model.md) — `remediation_catalogue_version`, `remediation_target`,
  `target_eligibility`, `remediation_action_bound`, `remediation_attempt`, `verification_window`,
  `undo_record`, `target_block`. Evidence, audit, policy decisions and workflow state belong to
  001, 002 and 012 and are referenced, not redefined; rate limits, cooldowns and attempt caps belong
  to 002 and are not stored here (C-11).
- [contracts/openapi.yaml](contracts/openapi.yaml) — the dashboard and API surface.
- [contracts/action-catalogue.md](contracts/action-catalogue.md) — the normative four declarations
  per action, plus the `remediation_directive` and result shapes carried by the runner protocol
  (012 `contracts/runner-protocol.md`).
- [contracts/events.md](contracts/events.md) — `RemediationProposed`, `RemediationDispatched`,
  `RemediationVerified`, `RemediationUndone`, `RemediationEscalated` and
  `RemediationCataloguePublished`: the events 001 and 002 already consume (C-09).
- [quickstart.md](quickstart.md) — scenarios, weighted toward the ones that must be refused.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Catalogue as code with a published version digest, not a table | Admission depends on a passing undo test in the current build; a row cannot carry that proof | A configurable catalogue makes "closed" a policy statement, and the first customer request turns it into an open one |
| Undo plan persisted before the mutation | The undo is needed exactly when the target has stopped answering questions | Deriving the undo from post-failure state fails in the only case that matters |
| Serialisation by a unique partial index rather than a lock | It survives a worker restart, a duplicate dispatch and a second API caller identically | A Redis lock expires under exactly the slow action it was protecting |
| Recurrence counted per `(target, fingerprint)`, not per issue | A recurring failure outside the reopen window creates a *new* issue (001 FR-005), so a per-issue cap never fires in the loop case | Counting per issue makes the restart loop invisible to its own attempt cap |
| Verification observations stored as evidence, not in a private table | The observation is the claim that the action worked, and Principle I governs claims | A private observation log is a second timeline that will eventually disagree with the first |
