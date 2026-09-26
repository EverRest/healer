# Feature Specification: Historical replay and the benchmark

**Feature Branch**: `011-simulator-and-eval`

**Created**: 2026-09-23

**Status**: Draft

**Input**: One mechanism serving two purposes — replay a historical issue to show what Healer would have done and where policy would have stopped it, and run the golden dataset to measure how well it does it. No production mutation is possible from either. The thresholds the constitution deliberately leaves unset are derived from this feature's output.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Point us at your last twenty incidents (Priority: P1)

A prospective customer has granted nothing. They export twenty incidents with repo state and logs.
Healer replays them and returns, per incident: the diagnosis it would have reached, the change it
would have proposed, the policy decisions that would have applied, where it would have stopped and
waited for a human, and what it would have cost. No repository write, no sandbox mutation, no
production access.

**Why this priority**: this is the only way to demonstrate behaviour before being granted access,
and access is granted on demonstrated behaviour. It is simultaneously the sales demo, the evaluation
harness and the safety tool — one artifact, which is why it is built before anything that writes
rather than after.

**Independent Test**: load a historical incident with repo state and logs, run a simulation → a
complete report is produced, and an audit of the run shows zero mutating operations against any
system.

**Acceptance Scenarios**:

1. **Given** a historical issue with recoverable repo state and logs, **When** it is replayed,
   **Then** the output contains diagnosis, proposed change plan, policy decisions, cost, risk
   classification and the step at which it would have stopped.
2. **Given** a replay, **When** policy is consulted, **Then** it uses dry-run evaluation
   (002 FR-019) and the report names the rules that produced each decision.
3. **Given** a replay of an incident where the customer's autonomy configuration would have refused
   an action, **When** the report is read, **Then** the refusal and the missing grant are shown as
   first-class output, not as an error.
4. **Given** a simulation run, **When** it completes, **Then** every conclusion in the report
   resolves to evidence records emitted by the producing step (001 FR-008, 001 FR-009).
5. **Given** a tenant with no integrations connected, **When** a replay is run from an imported
   dataset, **Then** it completes without requiring production access.

---

### User Story 2 - A simulation cannot touch production (Priority: P1)

A simulation run has no credentials that permit a write, no path to the remediation catalogue, no
path to the repository push surface, and no path to the answer publication event. Not because a flag
is set to false, but because the capability was never granted to the run.

**Why this priority**: the simulator's entire value is that a customer can run it before trusting
anything. A simulator whose safety depends on a configuration setting is a simulator that will one
day be run with the setting wrong, and the first time that happens the product is finished.

**Independent Test**: attempt every mutating operation in the product from inside a simulation run →
each is refused at the capability layer, with the refusal recorded, and no configuration exists that
would permit it.

**Acceptance Scenarios**:

1. **Given** a simulation run, **When** any mutating operation is attempted, **Then** it is refused
   because the run's credentials do not grant it, not because a mode flag was checked.
2. **Given** a simulation run, **When** its capability set is inspected, **Then** it contains **none of
   the four ADR 0008 capabilities** — `RepositoryWriteCapability`, `RemediationDispatchCapability`,
   `AnswerPublishCapability`, `DraftPublishCapability` — and no production credential. The assertion is
   made per capability, not per call site: `DraftPublishCapability` matters here as much as the others,
   because a knowledge draft is what an `ExpectedBehavior` adoption starts from (D-20, 005), and a
   simulation that could publish one would be manufacturing the anchors it is later scored against.
3. **Given** any configuration surface, **When** a tenant or an operator attempts to grant a
   simulation run a mutating capability, **Then** it is rejected by a product-level limit
   (002 FR-008).
4. **Given** a code path shared between simulation and live execution, **When** it reaches a
   mutation, **Then** the mutation is gated by capability rather than by a branch on run type.
5. **Given** a simulation runs code in the sandbox, **When** the sandbox is provisioned, **Then** it
   holds no production credentials and has default-deny egress, and the workspace is destroyed
   afterwards.

---

### User Story 3 - Scored on behaviour, never on resemblance to the human patch (Priority: P1)

A proposed fix is compared against what actually happened by asking five behavioural questions: does
the regression test pass, does the original failure stop reproducing, does the pre-existing suite
still pass, did impact analysis find an unintended behavioural change, did the incident recur. Its
textual similarity to the engineer's original patch is never scored.

**Why this priority**: diff similarity penalises a fix that is better than the original and rewards
one that copies a workaround. Optimising against it trains the product toward the wrong target, and
the damage is invisible because the score looks fine.

**Independent Test**: score a fix that is behaviourally correct but structurally unlike the human
patch, and a fix that closely resembles the human patch but fails to stop the reproduction → the
first scores as a success and the second as a false fix.

**Acceptance Scenarios**:

1. **Given** a scored attempt, **When** the score is computed, **Then** it uses only the behavioural
   criteria of S0-2 and no measure of textual or structural similarity to the historical patch.
2. **Given** a fix that differs substantially from the human patch but satisfies every behavioural
   criterion, **When** it is scored, **Then** it counts as a success.
3. **Given** a fix that passed every gate in the run, **When** the original failure still
   reproduces, **Then** it is recorded as a false fix.
4. **Given** a scoring criterion, **When** it is evaluated, **Then** it anchors on the recorded
   historical outcome, the pre-existing test suite or an adopted expectation — never on an artifact
   the same run produced.

---

### User Story 4 - False-fix rate and 30-day revert rate (Priority: P1)

Two numbers are reported next to everything else: the share of fixes that passed every gate and did
not fix the problem, and the share of merged fixes reverted within thirty days. They are what decide
whether anyone trusts the product, and almost nobody measures them.

**Why this priority**: every other metric can improve while these worsen, and only these two answer
the question the customer is actually asking. The constitution leaves the thresholds unset
specifically so they are set from these measurements.

**Independent Test**: seed a benchmark run containing known false fixes → the reported false-fix rate
matches the seeded count exactly, and each false fix is individually inspectable.

**Acceptance Scenarios**:

1. **Given** a completed benchmark run, **When** results are reported, **Then** false-fix rate and
   30-day revert rate appear alongside the other metrics, with their denominators stated.
2. **Given** a false fix, **When** it is inspected, **Then** the gates it passed, the evidence it
   used, the model and the prompt version are retrievable.
3. **Given** a fix merged in production, **When** it is reverted within thirty days, **Then** the
   revert is attributed back to the run that produced it and counted.
4. **Given** a metric is reported, **When** its provenance is requested, **Then** the exact set of
   scored issues producing it is enumerable.

---

### User Story 5 - The same run twice produces the same result (Priority: P1)

A run is repeated. The model version, prompt version, dataset version, retrieval index snapshot,
policy rule version and scoring version are all pinned. Differences between two runs are attributable
to something that was deliberately changed, not to drift.

**Why this priority**: D-07. A benchmark measuring a moving target measures nothing, and a threshold
derived from an unreproducible run cannot be defended when someone asks why it is what it is.

**Independent Test**: execute an identical run twice → identical scores, or the run is marked
non-deterministic with the varying component named.

**Acceptance Scenarios**:

1. **Given** a run configuration, **When** it is executed, **Then** it records model identifier and
   version, prompt version, dataset version, policy rule version, retrieval snapshot and scoring
   version.
2. **Given** two executions of the same pinned configuration, **When** results are compared, **Then**
   behavioural scores are identical, and any divergence is reported with the diverging component
   identified.
3. **Given** a run whose pinned model version is no longer available, **When** it is re-executed,
   **Then** it fails explicitly rather than silently substituting another version.
4. **Given** the eval harness, **When** it calls a model, **Then** the routing path used for
   evaluation is the one designated for evaluation only (D-10) and is recorded in the run metadata.

---

### User Story 6 - Real incidents preferred, synthetic ones labelled (Priority: P2)

The golden dataset holds incidents with their repo state, logs and recorded outcome. Real historical
incidents are the substance. Synthetic incidents — known bugs injected into real commits — fill gaps
and are marked as such everywhere they appear, because synthetic is easier than life and inflates
every number it touches.

**Why this priority**: S0-2. The dataset is the highest-value asset in the project, and an unlabelled
synthetic incident is a permanently corrupted measurement.

**Independent Test**: produce a report over a mixed dataset → every metric is broken down by real
versus synthetic, and no headline figure combines them without saying so.

**Acceptance Scenarios**:

1. **Given** a dataset entry, **When** it is stored, **Then** it carries the issue description, repo
   state reference, logs and context, the recorded historical outcome, the incident classification
   and its origin (`real` | `synthetic`).
2. **Given** a synthetic entry, **When** any metric including it is reported, **Then** the synthetic
   share is stated and the metric is also available for real incidents alone.
3. **Given** a dataset entry whose repo state is no longer recoverable, **When** a run is attempted,
   **Then** the entry is skipped and reported as unrunnable rather than scored as a failure.
4. **Given** the dataset, **When** it changes, **Then** it is versioned and prior runs continue to
   reference the version they used.

---

### User Story 7 - Compare models and prompt versions on identical issues (Priority: P2)

A prompt is changed. The same dataset is run against the old and the new version. The report shows
per-issue differences, not only aggregates — which incidents improved, which regressed, and which
newly produced a false fix.

**Why this priority**: an aggregate improvement that hides a new false fix is a regression. Per-issue
comparison is what makes that visible, and it is what justifies a prompt or model change.

**Acceptance Scenarios**:

1. **Given** two runs over the same dataset version differing in model or prompt version, **When**
   compared, **Then** the report shows per-issue outcome changes in both directions.
2. **Given** a comparison, **When** an issue regressed from success to false fix, **Then** it is
   highlighted independently of the aggregate direction.
3. **Given** results, **When** they are stored, **Then** they are addressable by model and prompt
   version (D-07).

---

### User Story 8 - Thresholds traceable to the data that justified them (Priority: P2)

The false-fix threshold, the per-incident cost ceiling and the escalation attempt cap each point at
the benchmark run that produced them. Changing one is a visible act with a dataset behind it.

**Why this priority**: the constitution leaves these unset on purpose. A threshold with no traceable
derivation is an opinion with a number attached, and it will be argued about forever.

**Acceptance Scenarios**:

1. **Given** a threshold value in effect, **When** its provenance is requested, **Then** it resolves
   to a specific benchmark run, dataset version and metric.
2. **Given** a threshold change, **When** it is made, **Then** it is audited with who changed it, the
   prior value and the run supporting the new one (002 FR-020).
3. **Given** a benchmark run whose results would not support a threshold in effect, **When** the run
   completes, **Then** the conflict is surfaced rather than the threshold silently standing.

---

### Edge Cases

- A historical incident's logs exist but the repo state does not → the entry supports diagnosis
  scoring only and is excluded from fix metrics, with the exclusion stated in the denominator.
- The historical outcome is unknown or the incident was never resolved → the entry is usable for
  reproduction and diagnosis metrics but cannot contribute to fix or false-fix rates.
- A simulation is run against an issue that is currently open → it is read-only over the live
  evidence and produces a plan; it never joins the live workflow.
- A replayed incident's dependencies are no longer installable → the run reports an environment
  failure distinct from a Healer failure, and it is not scored as a miss.
- The customer's incident export contains secrets or personal data → redaction happens on the
  customer's side before import, and an entry failing the redaction check is rejected rather than
  stored.
- A run exceeds its cost budget mid-dataset → it suspends in a resumable state with partial results
  marked partial (002 FR-011); a partial run is never reported as a full one.
- A prompt is edited without a version bump → runs referencing it are marked unreproducible and
  excluded from threshold derivation.
- Two tenants' datasets are used in one comparison → refused; comparisons are tenant-scoped.
- A scoring rule is changed → prior runs are not rescored in place; the scoring version is part of the
  run identity and a rescore is a new run.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide one replay mechanism serving both single-issue simulation and
  whole-dataset benchmarking, differing only in input selection and reporting.
- **FR-002**: A simulation run MUST produce a report containing the diagnosis, the reproduction
  outcome, the proposed change plan, every policy decision with the rules that produced it, the risk
  classification, the cost, and the step at which the run would have stopped for a human.
- **FR-003**: Policy evaluation within a run MUST use dry-run evaluation (002 FR-019), MUST reflect
  the tenant's actual configuration, and MUST report refusals and missing autonomy grants as output
  rather than as errors.
- **FR-004**: A simulation run MUST be incapable of mutating any production system, repository,
  remediation target or customer-facing surface. The guarantee MUST be structural — the run's
  capability set excludes those operations — and MUST NOT depend on a configuration value, mode flag
  or branch on run type.
- **FR-004a**: A simulation run MAY emit a `change_plan` directive, and an `agent_directive` for the
  change agent and the verifier (012 ADR 0010 places both in the runner), scoped to a **sandbox workspace**
  in the execution plane — a checkout at the entry's commit, with default-deny egress, no production
  credentials, and destroyed after the run (FR-026). Repository write and pull-request creation remain
  excluded: they take `RepositoryWriteCapability`, which no simulation bundle holds. Without this the
  gate results and the post-change reproduction do not exist, so `false_fix_rate` — the number the
  constitution defers L3 on — is permanently unmeasurable (C-10). 007 already places sandbox execution
  outside ADR 0008's scope, because the workspace holds no credentials and is reversible by deletion.
- **FR-005**: No configuration surface MUST permit granting a simulation run a mutating capability
  (002 FR-008).
- **FR-006**: A run MUST record its full pinned configuration: model identifier and version, prompt
  version, dataset version, policy rule version, retrieval snapshot identifier, scoring version and
  adapter versions.
- **FR-007**: Two executions of an identical pinned configuration MUST produce identical behavioural
  scores. Divergence MUST be reported with the diverging component named, and the run marked
  non-reproducible.
- **FR-008**: A run whose pinned model or prompt version is unavailable MUST fail explicitly and MUST
  NOT substitute another version.
- **FR-009**: The evaluation path MUST use the routing designated for evaluation only (D-10), and the
  production path MUST NOT use it. The routing used MUST be recorded in run metadata.
- **FR-010**: System MUST maintain a versioned golden dataset whose entries carry the issue
  description and signature, repo state reference, logs and context, recorded historical outcome,
  incident classification, reproducibility class and origin (`real` | `synthetic`).
- **FR-011**: Synthetic entries MUST be labelled, and every reported metric including them MUST state
  the synthetic share and MUST also be available over real incidents alone.
- **FR-011a**: Every dataset entry MUST declare a `split` of `dev` or `benchmark`, mandatory and with no
  default, set at creation and never updated. `benchmark` entries are the sealed measurement set; prompt,
  agent and policy iteration draws on `dev` entries and synthetic material only. A reclassification MUST
  be a new entry rather than an update, so an incident cannot enter the sealed set after it was tuned on
  (R-19).
- **FR-012**: A dataset entry whose repo state or required context is unrecoverable MUST be reported
  as unrunnable and excluded from denominators, never scored as a failure.
- **FR-013**: Scoring MUST use only behavioural criteria: the regression test passes, the original
  failure no longer reproduces, the pre-existing suite still passes, impact analysis finds no
  unintended behavioural change, and the historical incident did not recur.
- **FR-014**: Scoring MUST NOT use any measure of textual or structural similarity between the
  proposed change and the historical human patch.
- **FR-015**: Every scoring criterion MUST anchor on the recorded historical outcome, the pre-existing
  test suite, raw evidence or an adopted expectation, and MUST NOT anchor on an artifact produced
  earlier in the same run.
- **FR-016**: System MUST report, per run: diagnosis accuracy, reproduction rate, first-attempt fix
  rate, iterations to green, unintended changes, tokens consumed, latency, cost per resolved issue,
  **false-fix rate** and **30-day revert rate**, each with its denominator stated.
- **FR-017**: A false fix MUST be defined as an attempt that passed every gate in the run and did not
  satisfy the behavioural criteria, and each one MUST be individually inspectable with the gates it
  passed, its evidence, its model and its prompt version.
- **FR-018**: Reverts of Healer-produced changes observed in production within thirty days MUST be
  attributable to the run that produced them and counted in the revert rate.
- **FR-019**: Results MUST be versioned and addressable per model and per prompt version (D-07), and
  prior runs MUST remain readable when the dataset or scoring version changes.
- **FR-020**: System MUST support comparing two runs over the same dataset version, reporting
  per-issue outcome changes in both directions and highlighting regressions into false fixes
  independently of the aggregate direction.
- **FR-021**: Every threshold derived from benchmark output — false-fix threshold, per-incident cost
  ceiling, per-tenant daily budget, escalation attempt cap — MUST record the run, dataset version and
  metric that justify it, and a change to one MUST be audited (002 FR-020).
- **FR-021a**: The minimum scored-real denominator for deriving an autonomy-governing threshold —
  `min_real_yield` — MUST be the product constant **20** (R-15, SC-011). It MUST be established the
  way 002's `ACTION_CEILING` is: a constant in code, the literal written into the migration as a check
  constraint on `threshold_derivation.real_denominator`, and a test asserting the two agree. No
  configuration surface, request body or environment variable MUST be able to lower it; raising it is a
  spec change with a constitution amendment.
- **FR-021b**: An autonomy-governing threshold MUST be derived only from a run whose `split_scope` is
  `benchmark`. `split_scope` MUST be computed from the entries the run actually scored rather than
  declared by the caller, and MUST be copied onto the derivation row under the same composite foreign key
  that already keeps the synthetic, completion and reproducibility copies honest (R-19, R-04).
- **FR-021c**: Every derivation MUST be exportable as a self-contained artifact naming the threshold, the
  value, the run, the dataset version, the metric, the scored real denominator and the four run facts, so
  that a continuous-integration check with no database access can resolve it (012 `gate-ceiling`). The
  database row remains the authority; the artifact is provenance, and the two MUST be reconciled
  continuously — a committed artifact with no row, or a digest that disagrees, is a failure (R-20).
- **FR-022**: A benchmark run whose results contradict a threshold currently in effect MUST surface
  the conflict.
- **FR-023**: A run exceeding its cost budget MUST suspend in a resumable state with results marked
  partial (002 FR-011), and a partial run MUST NOT be reported as complete or used to derive a
  threshold.
- **FR-024**: Every dataset entry, run, result and derived threshold MUST carry `tenantId`, and every
  read MUST be constrained by the `tenantId` from the authenticated context (001 FR-015). A
  comparison or aggregate spanning two tenants MUST be refused, and a run MUST NOT retrieve context
  belonging to another tenant.
- **FR-025**: Imported incident data MUST pass a redaction check before storage; an entry failing it
  MUST be rejected rather than stored.
- **FR-026**: Sandboxes used by a run MUST hold no production credentials, MUST have default-deny
  egress, and MUST be destroyed after the run.
- **FR-027**: Every run MUST be written to the audit trail with its configuration, inputs, decisions
  and outcome (001 FR-012), and every conclusion in a run report MUST carry evidence references
  emitted by the producing step (001 FR-008, 001 FR-009).
- **FR-028**: Model-reported confidence MUST NOT be a scoring criterion or a gate within a run
  (002 FR-003); it MAY be reported as an observed value for calibration analysis only.

### Key Entities

- **GoldenIssue**: a dataset entry. Issue description and signature, component, repo state reference,
  logs and context bundle, recorded historical outcome, fix reference where one exists, incident
  classification, reproducibility class, origin (`real` | `synthetic`), dataset version.
- **Dataset**: a versioned, tenant-scoped collection of `GoldenIssue` entries with its composition
  summary including synthetic share.
- **RunConfiguration**: the pinned set — model, prompt version, dataset version, policy rule version,
  retrieval snapshot, scoring version, adapter versions, budget.
- **SimulationRun**: an execution over one issue or a dataset. Configuration, capability set, start
  and end, cost, completion state (`complete` | `partial` | `failed`).
- **RunReport**: per-issue output — diagnosis, reproduction outcome, proposed change plan, policy
  decisions with rules, stop point, risk, cost, evidence references.
- **Score**: the behavioural verdict per issue, criterion by criterion, with the anchor each criterion
  used.
- **RunMetrics**: the aggregate set for a run, each metric with its numerator, denominator and
  exclusions.
- **ThresholdDerivation**: a threshold value with the run, dataset version and metric that justify it,
  and its change history.
- **RunComparison**: two runs over one dataset version with per-issue outcome deltas.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 mutating operations occur during any simulation run, verified by an audit of the
  run's capability set and by an attempt matrix covering every mutating operation in the product.
- **SC-002**: 0 configurations exist that can grant a simulation run a mutating capability.
- **SC-003**: Repeating a pinned run produces identical behavioural scores in 100% of reproducibility
  tests, or names the diverging component.
- **SC-004**: 100% of runs resolve to a retrievable model version, prompt version, dataset version
  and scoring version.
- **SC-005**: 0 scoring criteria reference similarity to the historical human patch, verified by an
  automated check over the scoring definition.
- **SC-006**: A seeded benchmark containing known false fixes reports a false-fix rate exactly
  matching the seeded count.
- **SC-007**: Every reported metric states its denominator and its exclusions, with 0 metrics
  combining real and synthetic incidents without labelling the split.
- **SC-008**: A prospective customer's exported incident history can be replayed end to end with no
  integration connected and no credential granted.
- **SC-009**: Every threshold in effect resolves to a benchmark run and dataset version, with 0
  thresholds lacking a derivation record.
- **SC-010**: 0 cross-tenant dataset entries, run results or comparisons are reachable in the
  isolation test matrix.
- **SC-011**: No threshold is derived until a run's **scored real denominator** for the metric it cites
  reaches 20 — the stage-0 exit figure, read as scored real results rather than as dataset rows
  (R-04, R-15, FR-021a). A 25-entry dataset with 8 unrunnable entries yields 17 and derives nothing,
  which is why dataset size is the wrong subject: it can satisfy the number while the run never produced
  it.
- **SC-012**: 0 thresholds in effect resolve to a run that scored a `dev` entry, and 0 entries have moved
  from `dev` to `benchmark` since creation (FR-011a, FR-021b).
- **SC-013**: Every derivation artifact committed to the repository resolves to a `threshold_derivation`
  row with a matching digest, and every row in effect has one — 0 discrepancies in either direction
  (FR-021c).

## Assumptions

- This specification owns the replay mechanism, the golden dataset, scoring, metrics and threshold
  derivation. It does **not** own the policy rules themselves (002), diagnosis (006), reproduction
  (007), change generation and verification (008), or the model router, which is post-v1. It consumes
  002's dry-run evaluation and does not re-implement policy.
- The dataset is constructed in stage 0 (S0-1, S0-2) from the design partner's incident history. This
  specification defines its shape and its use, not its initial population.
- Synthetic incidents are permitted to fill gaps and are always labelled, but **no threshold that
  governs autonomy may be derived from a run containing any synthetic incident.** Synthetic material
  serves development and regression detection only. Metrics are always reported separately for real
  and synthetic and are never combined into a single headline figure. If the real-incident yield is
  too small to establish a threshold, the correct outcome is that no threshold exists and the L2
  ceiling stands — not a threshold resting on results that synthetic incidents inflate.
- 30-day revert rate requires production observation of merged changes and is therefore reportable
  only for tenants running at L2 or above for long enough; it is stated as unavailable rather than as
  zero until it has data.
- Cost figures are measured, not estimated, from the same accounting the production path uses
  (002 FR-011), so a benchmark cost and a live cost are comparable.
- Simulation runs are tenant-scoped even when used as a sales demonstration; prospect data is imported
  into a tenant, never handled outside one.
- Incident import assumes redaction happened in the customer's execution plane. Healer does not
  redact on receipt; it rejects what arrives unredacted.
