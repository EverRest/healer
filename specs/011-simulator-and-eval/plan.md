# Implementation Plan: Historical replay and the benchmark

**Branch**: `011-simulator-and-eval` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

One replay mechanism with two readings. Point it at a single historical incident and it is a trust
instrument — *here is what we would have done to your last twenty, and where policy would have
stopped us*. Point it at the golden dataset and it is the benchmark from which stage 0 derives the
thresholds the constitution deliberately leaves unset (S0-3). The mechanism is identical; only input
selection and reporting differ.

Two commitments shape the design. **A simulation run cannot mutate anything that survives it** —
mutating operations are reached only through a capability object passed into the call, the credential
broker has no representable grant for a simulation principal, and the runner directive types a
simulation may send exclude `remediation_directive`. A run type flag checked in a branch would be
correct until the day it is not, and that day ends the product. The one thing a run *may* change is a
**sandbox workspace**, through `change_plan`: without executing the candidate patch there are no gate
results and no post-change reproduction, so `false_fix_rate` would be unmeasurable and the benchmark
could not answer the question it exists for (C-10, FR-004a). Repository write stays excluded, and the
workspace is destroyed afterwards — 007 already places sandbox execution outside ADR 0008 for that
reason.

And **scoring never sees the human patch**. The scorer is handed a ground-truth object that contains
the historical outcome, the pre-existing suite and the recorded recurrence, and does not contain the
fix diff. A similarity metric cannot be written against data the function was not given — which is a
stronger guarantee than a rule saying not to write one, and it is what stops the benchmark from
punishing a fix better than the original.

C-05 is the third: **no autonomy-governing threshold may rest on a run containing a synthetic
incident**, and that is a database constraint here, not a paragraph.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`), Prisma 6, BullMQ, Zod (dataset import,
report and score schemas), Pino, OpenTelemetry. Model access through the provider-agnostic `LLM`
interface (012 FR-045); the evaluation-designated routing adapter is registered only inside this
package (D-10)

**Storage**: PostgreSQL — schema `eval`. No customer source is retained in the control plane: a
dataset entry holds a repository reference and a commit SHA, or a digest of a bundle that stays in
the execution plane (R-10, C-04)

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12); an attempt matrix e2e
suite that tries every mutating operation in the product from inside a simulation run (SC-001)

**Target Platform**: control plane for orchestration, scoring and reporting; sandbox execution and
repository access in the execution plane (007, ADR 0001). A prospect with nothing connected runs
the runner image locally — outbound-only, no inbound rule, no credential granted (C-01)

**Project Type**: domain package `packages/domain/evaluation`, plus the capability types every
mutating call site takes as an argument

**Performance Goals**: a twenty-incident dataset completes within one working session; per-entry
results are committed as they are scored, so a run can be suspended and resumed without repeating
work

**Constraints**: no mutating capability exists in a simulation run and none can be configured; a run
that cannot resolve its pinned model or prompt version fails rather than substituting; a threshold
cannot be persisted against a partial run, a non-reproducible run, or a run that scored any
synthetic entry

**Scale/Scope**: stage-0 exit is 20 real incidents with recoverable repo state (SC-011); the dataset
grows from there and is versioned at every change

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every conclusion in a run report carries evidence links emitted by the producing step (001 FR-008, FR-009); a metric resolves to the exact set of scored entries that produced it (FR-016) | ✅ |
| II. Anti-Circular Verification | Every scoring criterion anchors on the recorded historical outcome, the pre-existing suite, raw evidence or an adopted expectation — never on an artifact the same run produced (FR-015, R-07) | ✅ |
| III. Reproduce Before Modify | The replay runs 007's ladder unchanged; an unreproducible entry yields `INCONCLUSIVE` and is reported, not scored as a miss | ✅ |
| IV. Deterministic Control | Policy inside a run is 002's dry-run evaluation (FR-003), not a re-implementation; scoring is deterministic and versioned; model confidence is recorded but is never a criterion (FR-028, 002 FR-003) | ✅ |
| V. Dependency-Aware Change | The unintended-change criterion is 008's impact analysis, consumed not re-derived | ✅ |
| VI. Serialize / Parallelize | Entries are scored independently and committed one by one; a long dataset run is a persisted state with per-entry checkpoints, never a job that waits (012 FR-025) | ✅ |
| VII. Architecture Agnostic | A dataset entry references a `Component` (004) and a commit, never a service name | ✅ |
| VIII. Simplicity | A run comparison is a query over two runs, not a stored artifact; cost is read from 012's `agent_run` rows, not counted a second time | ✅ |

**Security**: the simulation principal is a distinct actor kind whose credential the broker cannot
mint (R-01). Sandboxes hold no production credentials, apply default-deny egress and are destroyed
after the run (FR-026, 007 FR-011, FR-012, FR-014). Imported incident data must already be redacted
in the customer's plane; an entry that is not is rejected rather than cleaned (FR-025, R-10).

**Tenancy**: dataset entries, runs, reports, scores, metrics and threshold derivations all carry
`tenantId`. A comparison spanning two tenants is refused at the query layer, and a run cannot
retrieve context outside its tenant (FR-024, 012 FR-048).

## Project Structure

### Documentation (this feature)

```text
specs/011-simulator-and-eval/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml    # datasets, runs, reports, metrics, comparisons, thresholds
    └── scoring.md      # the criteria, their anchors, the cohort rule, the derivation record
```

### Source code

```text
packages/domain/evaluation/
├── domain/
│   ├── run-configuration.ts   # the pinned set and its digest
│   ├── scoring/               # criteria, anchors, verdict aggregation — versioned
│   ├── cohort.ts              # real / synthetic separation; no combined headline exists
│   └── threshold.ts           # derivation eligibility predicates (C-05)
├── application/
│   ├── commands/              # ImportEntries, PublishDatasetVersion, StartRun, ResumeRun,
│   │                          # ScoreEntry, RecordRevertObservation, DeriveThreshold
│   └── queries/               # GetRun, GetRunReport, GetMetrics, CompareRuns,
│                              # GetThresholdProvenance
├── infrastructure/            # Prisma repositories, evaluation-only LLM routing adapter
└── presentation/              # controllers, DTOs

packages/shared/capabilities/  # the capability types every mutating call site accepts as an
                               # argument — the mechanism behind FR-004
```

**Structure decision**: the capability types are shared rather than owned by this feature, because
the guarantee is enforced at the *mutating* call sites — repository write (008), remediation
dispatch (010), support publication (009), knowledge draft publication (005) — and a type owned by the
simulator would invert the dependency. The cross-cutting pattern is settled in
[ADR 0008](../../docs/adr/0008-capability-passing.md), **accepted 2026-09-24**, which names those four
operations and their capabilities; this feature implements the shared types and the empty simulation
bundle against it rather than proposing it. It also contributes one boundary pattern to the lint rule
set that 012 FR-002 and FR-003 already provide for.

## Phase 0 — research

See [research.md](research.md): how the no-mutation guarantee is made structural, what
reproducibility means when the model is not deterministic, how C-05 becomes a constraint rather than
a convention, why the scorer is never given the human patch, how a criterion that cannot be
evaluated is handled honestly, how the 30-day revert rate stays `unavailable` instead of becoming
zero, and what a prospect with nothing connected actually runs.

## Phase 1 — design

- [data-model.md](data-model.md) — `golden_issue`, `dataset_version`, `dataset_entry`,
  `run_configuration`, `simulation_run`, `run_report`, `score`, `score_criterion`, `run_metric`,
  `revert_observation`, `threshold_derivation`. Issues, evidence and audit belong to 001; policy
  decisions to 002; prompts, agent runs and costs to 012.
- [contracts/openapi.yaml](contracts/openapi.yaml) — the import, run, report and threshold surface.
- [contracts/scoring.md](contracts/scoring.md) — the normative criteria, the anchor each uses, the
  cohort rule and the shape of a threshold-derivation record.
- [quickstart.md](quickstart.md) — scenarios, weighted toward the ones that must be impossible.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Capability objects passed to every mutating call site ([ADR 0008](../../docs/adr/0008-capability-passing.md), accepted) | It is the only form of FR-004 that survives a careless edit; a flag does not | A `readOnly` flag is one inverted condition away from a write, and the condition sits in the code that writes to production |
| Per-cohort metric rows with no combined figure | C-05 says real and synthetic are never one headline number; the way to guarantee that is for the number to have nowhere to live | A reporting convention holds until the first deck that wants one figure |
| Threshold eligibility as database check constraints | A threshold resting on synthetic data permits autonomy that was not earned — the exact failure this product exists to prevent | Validation in application code is bypassed by the first script that inserts a row |
| Score input excludes the fix diff | A similarity metric cannot be written against data the function never receives (SC-005) | A rule against similarity scoring is enforceable only by review, and the damage is invisible because the score looks fine |
| Criteria are tri-state, with `not_applicable` recorded | Recurrence cannot be observed for a replayed incident; pretending otherwise fabricates a passing criterion | Scoring an unobservable criterion as a pass inflates every number that depends on it |
