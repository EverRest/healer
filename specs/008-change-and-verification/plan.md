# Implementation Plan: Impact analysis, TDD fix, independent verification, pull request

**Branch**: `008-change-and-verification` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

The only part of Healer that writes to a customer's repository. It knows what a change reaches
before it opens a file, declares the change before making it, writes a regression test against an
expectation that a human adopted before the issue existed, proves RED then GREEN in that order, has
a second agent that may reject the diagnosis and not only the patch, and opens a pull request it
cannot merge.

Three commitments carry the design.

**The anchor is resolved by a deterministic step, not by an agent.** The regression test's assertion
must trace to an `ExpectedBehavior` version carrying a live `anchor_grant` — the only thing that can
name an anchor (C-12) — adopted by a human before the issue's `first_seen_at` (005 FR-011). A test that merely fails on the old code proves nothing,
because a wrong test also fails on the old code. 008 does **not** trust 006's `NO_EXPECTATION`
finding in either direction — 006 is an earlier step in the same chain — it re-resolves the anchor
itself against 005 and refuses to proceed on anything but `ANCHORED`. The change component holds no
write credential into knowledge, so authoring an anchor is not an action it can take.

**Deterministic facts are a floor no model can lower.** The change graph is built by parsing
(ts-morph) and stored with a derivation on every edge. A model's contribution is an additive
annotation in a separate table with no delete path, so "the model removed an edge" is not a
representable state rather than a forbidden one. Impact classification consumes touched-fact
predicates only; file count and diff size are not fields on its input.

**Order is the proof.** GREEN's transition guard requires a signature-matched RED execution, on the
patch's parent commit, for the same test identifier, recorded by 007's sandbox with an immutable
execution identifier (007 FR-013). The change agent cannot mint an execution record, so the skip is
unsatisfiable rather than merely refused.

**Hard boundary: no merge. Ever, in this release** (D-12, constitution "Autonomy Levels"). No merge
method exists on the VCS port, the change agent's credential excludes merge, policy enforces the
product-level ceiling (002 FR-008), and a build gate fails if a merge-capable call appears. Four
layers, because the one that matters is the one nobody remembered to check.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`), Prisma 6, BullMQ, **ts-morph / TypeScript
compiler API** (change graph — constitution stack table), Zod (structured agent output, boundary
schemas), Pino, OpenTelemetry. GitLab adapter from `packages/integrations` (012 FR-001)

**Storage**: PostgreSQL — `change` schema. The change graph is nodes and edges traversed by
recursive CTE (ADR 0004, 012 FR-047); no graph database

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12). Two fixture corpora are
first-class test assets: the **impact corpus** (auth guard, shared utility, migration, mechanical
rename) and the **masking corpus** (added catch, swallowed rejection, retry, default fallback,
widened type, weakened test)

**Target Platform**: split by ADR 0001. Change graph construction, patch application and test
execution run in the **execution plane** — they need the source tree. Impact analyses, change plans,
verdicts, attempts and pull request records live in the **control plane**. Only structured graph
nodes, edges and results cross (007 FR-026, 012 FR-022)

**Project Type**: `packages/domain/change` (this feature), `packages/code-intelligence` (the
deterministic graph, shared), `packages/agents/{change,verifier}`, `packages/integrations/gitlab`

**Performance Goals**: change graph over a 500 kLOC monorepo under 90 s with a warm project graph,
under 6 min cold; impact classification under 2 s once the graph exists; pull request assembly under
5 s; the fix loop's own overhead outside sandbox and model latency under 500 ms per transition

**Constraints**: no write outside the current `ChangePlan`; no GREEN without a signature-matched
RED; no `PASS` resting on a quarantined test; no merge capability anywhere in the product; model
confidence recorded, never read by a gate (FR-019)

**Scale/Scope**: change graphs of ~10⁵ nodes per repository; several fix attempts per issue bounded
by the escalation cap (002 FR-013); attempts retained permanently

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every impact analysis, plan, attempt, verdict and pull request emits its own links as it runs (FR-030, 001 FR-008); the anchor resolution is itself an evidence-bearing record, not a field an agent fills | ✅ |
| II. Anti-Circular Verification | The load-bearing feature. Anchor resolved deterministically against 005 and independent of 006's claim; verifier receives projections of results and anchors, never the change agent's reasoning; `APPROVE` refused when the achieved independence rank is self-review (FR-018) | ✅ |
| III. Reproduce Before Modify | The loop cannot start without a 007 reproduction at `FAIL` (FR-009, 007 FR-001); `INCONCLUSIVE` never opens the fix path | ✅ |
| IV. Deterministic Control | `ChangePlan` is evaluated by 002 before any modification (FR-004); classification comes from touched-fact predicates; confidence is not an input to any gate (FR-019, 002 FR-003) | ✅ |
| V. Dependency-Aware Change | This feature *is* Principle V: graph first, classification from what is touched, size never an input (FR-001..003) | ✅ |
| VI. Serialize / Parallelize | Graph construction fans out; repository mutations serialise per repository through a persisted lease, and waiting for it is a workflow state with a deadline, never a blocked job (FR-029, 012 FR-025) | ✅ |
| VII. Architecture Agnostic | Impact is expressed over `Component` and contract nodes (004), not service names; language support lives in code-intelligence adapters and a missing adapter degrades the graph explicitly | ✅ |
| VIII. Simplicity | Masking detection is AST pattern inspection, not a model; the change fingerprint is a hash; the PR completeness check is a schema | ✅ |

**Autonomy**: ceiling is L2 — fix plus pull request (D-12). FR-024 is enforced at four layers, and
SC-001 is verified by reconciling repository merge events against Healer actor identities, because
"we did not implement it" is a claim and reconciliation is a measurement.

**Tenancy**: every table carries `tenant_id` (012 FR-048); repository credentials and CI
integrations are per tenant; a foreign identifier returns not-found (001 FR-015, 012 FR-013).

**Security**: the change agent proposes; a separate privileged applier holds the write credential
and validates every hunk path against the plan (FR-025). Commit messages, PR text and issue bodies
reaching either agent are data (constitution "Security Model").

## Project Structure

### Documentation (this feature)

```text
specs/008-change-and-verification/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml    # plans, attempts, verdicts, pull request records, CI callback
    ├── fix-loop.md     # the state machine and its transition guards — the anti-circularity contract
    └── events.md       # domain events published through the outbox
```

### Source code

```text
packages/code-intelligence/
├── graph/            # ts-morph project, symbol references, type graph, call graph
├── extractors/       # contracts, prisma models and migrations, test-to-code map, events, flags
├── diff/             # AST-level diff classification — the masking patterns live here
└── ports/            # ChangeGraphPort — the shape that crosses the plane boundary

packages/domain/change/
├── domain/           # ChangeGraph, ImpactClassifier, FixLoop state machine, AnchorResolver,
│                     # ApproachFingerprint, RollbackPlan
├── application/
│   ├── commands/     # AnalyseImpact, ResolveAnchor, SubmitChangePlan, ExtendChangePlan,
│   │                 # ApplyPatch, RecordExecution, RequestVerification, OpenPullRequest
│   └── queries/      # GetImpactAnalysis, GetChangePlan, ListFixAttempts, GetVerdict, GetPullRequest
├── infrastructure/   # Prisma repositories, repo mutation lease, GitLab adapter binding
└── presentation/     # controllers, DTOs, CI callback

packages/agents/
├── change/           # proposes patch and regression test — no repository credential
└── verifier/         # reads projections only — credential cannot write
```

**Structure decision**: `code-intelligence` is a package outside `domain/change` because the change
graph is not the change feature's private asset — 004 consumes it for discovery, 011 replays it, and
the runner executes it where the source is. Putting it inside `change` would force every consumer to
depend on the feature that happens to write files.

The change agent and the verifier are separate packages with separate prompt keys and separate
credentials. Same-package siblings drift into sharing a helper that carries the first agent's
reasoning into the second, and that shared helper is exactly the circle this feature exists to
prevent.

## Phase 0 — research

See [research.md](research.md): where the graph is computed, how a model is prevented from removing
an edge, classification from touched facts, anchor resolution and why 006 is not trusted for it,
RED signature matching, transition guards that make skipping unsatisfiable, baseline capture,
quarantine, masking detection and what "behavioural assertion satisfied" means concretely, verifier
input firewall and independence ranking, privileged application, repository serialisation, pull
request idempotency, the four layers of no-merge, approach fingerprints, and degraded language
coverage.

## Phase 1 — design

- [data-model.md](data-model.md) — the `change` schema: impact analyses, graph nodes and edges, the
  model annotation overlay, plan versions, anchor resolutions carrying 005's `anchor_grant_id`,
  regression tests, attempts, baselines, quarantine, masking findings, verdicts, pull request records,
  the per-component verification policy and mutation leases — plus the one cross-feature addition this
  feature needs, `change_graph` in 012's closed boundary list.
- [contracts/fix-loop.md](contracts/fix-loop.md) — states, guards, and what each guard reads. This
  is the document a reviewer checks Principle II against.
- [contracts/openapi.yaml](contracts/openapi.yaml) — read surface, plan submission, the CI callback and
  the inbound merge-fact callback (R-26).
- [contracts/events.md](contracts/events.md) — what 001, 009 and 011 subscribe to.
- [quickstart.md](quickstart.md) — scenarios, weighted toward the ones that must be refused.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Model annotations in a separate table rather than fields on the edge | Removal must be unrepresentable, not merely forbidden | An `active` flag on the edge gives the model a delete in disguise, and the first person to write `where active` reintroduces it silently |
| `AnchorResolution` as its own record instead of a field on the regression test | It is a verification anchor; it must be produced before the test exists and be independently auditable (SC-002) | A field on the test lets the step that writes the test also write what the test is checked against — the exact circle of ADR 0002 |
| Code intelligence as a shared package, not part of `domain/change` | Three other features consume the graph, and it executes in the runner | Nesting it makes 004 and 011 depend on the write path to read a call graph |
| Separate privileged applier process from the proposing agent | Permissions are what tools grant, not what prompts say (constitution Security Model) | An agent holding the write credential makes "refuse writes outside the plan" a code path someone can bypass rather than a credential they do not have |
| Two fixture corpora maintained as product assets | SC-008 and SC-009 are unmeasurable without them, and both thresholds come from stage 0 | Ad-hoc test cases drift toward the cases the implementation already passes |
