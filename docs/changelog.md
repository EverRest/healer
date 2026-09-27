# Changelog

## 0.1.0 — 2026-09-23

Specification stage. No code.

- Constitution 1.0.0 — 8 principles; Evidence First, Anti-Circular Verification and Deterministic
  Control are non-negotiable.
- 23 decisions recorded in [decisions.md](decisions.md), with rejected options and their reasons.
- ADRs 0001–0007.
- Research wiki seeded: product thesis, incident taxonomy, failure modes, knowledge model,
  trust and adoption, security posture, market.
- Stage 0 defined; S0-1 (incident history audit) blocks realistic sizing of v1.

## 0.2.0 — 2026-09-24

Specification stage complete. Still no code.

- All 12 features specified, clarified, planned and broken into tasks: 340 functional requirements,
  133 success criteria, 1 094 tasks across 121 phases, 219 research entries, 27 contract documents.
- Seven clarifications resolved (C-01..C-07); four dissolved by reframing rather than by choosing a
  value.
- ADR 0008 added: capability passing for irreversible operations.
- Roughly thirty gaps found while writing tasks — where a spec or plan had left something
  unspecified — resolved rather than deferred, except the numeric values, which are now tracked
  explicitly in [stage-0.md](stage-0.md) S0-7.
- Notable correction: `ChangeVerifiedInProduction` is **not** emitted in v1. At L2 Healer neither
  merges nor deploys, so it never observes its own change in production. `IssueResolved` in v1 comes
  only from a verified reversible remediation or from a human.

## 0.3.0 — 2026-09-24

Specification stage complete and analyzed. Still no code.

- `/speckit-analyze` across all twelve specs: ≈110 findings, 10 CRITICAL, ~47 HIGH. Every spec was
  internally complete — FR→task 342/342, every success criterion and quickstart scenario covered,
  zero orphan tasks — and **all of the damage was at the seams between specs**.
- Twenty-one decisions recorded, C-08..C-28.
- Four recurring failure shapes, each fixed in every place it appeared: a guarantee that was prose
  rather than mechanism; a research decision that never reached the data model or tasks; a gate with
  no reader; an incentive problem wearing the clothes of a missing field.
- **Playwright and browser reproduction were missing from all twelve specs** while v1 targets a
  monorepo with a frontend. Resolved as two ladders selected by where the symptom is observable
  (C-24..C-28), which also fixed the reverse error — using a browser to reproduce a log-derived
  endpoint error.
- New cross-cutting docs: [patterns.md](patterns.md), [domain/glossary.md](domain/glossary.md),
  [workflows/investigation-pipeline.md](workflows/investigation-pipeline.md),
  [runbooks/runner-diagnosis.md](runbooks/runner-diagnosis.md).
- 1 151 tasks across twelve specs. Nothing open in the artefacts; stage 0 S0-1 still blocks sizing.

## 0.4.0 — 2026-09-24

Stage-0 review. Still no code.

- Walked the seven stage-0 items one at a time and recorded four decisions, C-29..C-32. Totals now
  **366 functional requirements, 138 success criteria, 1 166 tasks, 235 research entries, 587 quickstart
  scenarios**; FR coverage 366/366, 988 cross-spec requirement references, 112 task references and every
  internal link resolving.
- **The golden dataset is split** (C-29). Every entry declares `split ∈ dev · benchmark`, mandatory and
  never updated, on the entry rather than on dataset membership so an incident cannot be laundered into
  the sealed set by publishing a new version. Only a `benchmark`-scoped run may derive a threshold — a
  fifth check constraint alongside the four that already enforce C-05. The four thresholds that govern
  autonomy were being measured on the same incidents the prompts were tuned against.
- **The autonomy ceiling gained a gate on its own edit** (C-30). `gate-ceiling` validated grant rows
  against `ACTION_CEILING` and nothing looked at the function itself, so a pull request giving `merge` a
  level passed every gate in the repository — while the absence of that level is the whole of what holds
  v1 at L2. A raise now cites a `threshold_derivation` artifact the build can resolve without a database;
  the row stays the authority and the two are reconciled in both directions.
- **All six adapters stay in v1, with rollback landing in staging first** (C-31). The tempting cut —
  deploy and runtime, since at L2 Healer never deploys — does not survive the specs: 010's P1 story is
  rollback and 004's `DeploymentUnit` carries runtime identity.
- **Every unset value ships a starting value chosen to fail closed; four ship a clamp instead** (C-32):
  009's predicate 2 trust floor, 007's per-rung repeat counts, 002's escalation cap and budgets, 006's
  hypothesis threshold. Each is individually rational to lower and collectively they are the product's
  stop rules.
- S0-5 gained a real exit criterion: the share of a feature's historical incidents an adopted expectation
  would have covered, which is what predicts the `NO_EXPECTATION` rate and therefore how often 008's fix
  path fires at all. Adoption volume was never the criterion.
- [security-posture.md](security-posture.md) assembled for procurement out of ADR 0001, ADR 0006 and
  012's runner protocol — a consolidation, not new material, with the honest limit about source code
  reaching a model provider as its own named section rather than a line in the middle.
- Correction: the S0-7 table listed a *"masking rejection threshold"* for 008. No such threshold exists —
  masking detection is deterministic inspection and a hard refusal, and SC-009 is a fixture outcome.
- **Constitution 1.1.0**: three governance rules — a ceiling raise is gated on the build against a sealed
  measurement; every unset value ships a fail-closed starting value and, where it is a stop rule, a bound
  configuration cannot cross; a guarantee must name the mechanism that refuses to proceed without it.
- **ADR 0009**: derivation artifacts, and gating a diff rather than data.
- **[runbooks/raising-autonomy.md](runbooks/raising-autonomy.md)**: the procedure, and what each refusal
  means — written because the procedure was invented in this review and existed nowhere.
- Wiki: two failure modes added (measuring on the data you tuned on; a gate with no reader), trust-and-adoption
  gained "the rung is gated by a build, not by a conversation", the research security note now points at the
  customer-facing document rather than competing with it, and knowledge-model records that adoption volume
  was the wrong measure.
- Glossary: **stale entry fixed** — `Rung` still described one reproduction ladder after C-24 introduced two.
  Added `observableLocation`, `ThresholdDerivation`, `Derivation artifact`, `Clamp`, `Split`, `split_scope`,
  and a do-not-use row for "masking rejection threshold".

## 0.34.0 — 2026-09-27

**Closed three tracked open items** from a QUESTIONS.md review, decided in `docs/decisions.md`.

- **C-52: `apps/api` gets a global `/api/v1` prefix** on every route
  (`app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] })`) — closes the gap between the
  001 contract ("All paths under /api/v1") and the running server, which had no prefix at all.
  `/health`/`/ready` stay unprefixed permanently — an orchestrator's probe path is infrastructure
  configuration, not an API consumer. One `configureApiPrefix` helper, reused by `bootstrap()`,
  OpenAPI generation and every e2e test that boots a real server, so they can't drift apart.
  `POST /ingest/signals` moves to `POST /api/v1/ingest/signals`.
- **C-50/C-51**: the T019 auth stub (`X-Tenant-Id`/`X-Provider-Id` → `forTrustedInternalUse`) and
  the T022 reopen-window placeholder (14 days) are recorded as deliberate, tracked gaps — not
  resolved further now, since closing either properly needs work this task set doesn't own (real
  `ingestBearer` auth; a tenant-configuration store). No code change; the decision is the record.
- `make ci`: 49 unit files / 262 tests, 15 e2e files / 121 tests, all gates pass.

## 0.33.0 — 2026-09-27

**001 T022**: reopen and recurrence — a matching signal inside the reopen window reopens a
resolved issue; outside it, a new issue is created and linked `recurrence_of` the old one.

- `ingestSignal` extended: when nothing *open* matches the fingerprint, a new
  `findMostRecentlyResolvedByFingerprint` looks for the most recently resolved issue sharing it
  (ordered by `resolvedAt` — a recurrence chain can leave more than one resolved issue with the
  same fingerprint). Inside the reopen window → `transition` to `investigating` then
  `recordOccurrence`; outside it (or nothing was ever resolved) → `create`, now carrying an
  optional `recurrenceOf`, which writes the `recurrence_of` `issue_relationship` row and a
  `related`-type `issue_event` in the same transaction as the issue.
- New migration `20260927050000_issue_reopen_recurrence` adds `issue.resolved_at` — set the moment
  `state` becomes `resolved`, cleared on reopen. The acceptance scenarios measure the window from
  *when the issue was resolved*, not from its last signal, and that timestamp isn't cheaply
  derivable from `issue_event` on the ingestion hot path; same denormalized-status-timestamp shape
  `stale_at` already uses.
- Reopen window is 14 days — `docs/stage-0.md` S0-7 names this exact value as deliberately left
  unset pending real incident-cadence data; documented as a placeholder next to the constant.
- The window compares against the signal's own `observedAt` (R-10, source clock, not receipt
  time); a negative difference (the signal predates the resolution) routes to recurrence rather
  than reopen — a real, documented edge case.
- Ten new `issue-repository.e2e.test.ts` cases (24/24), two new `ingest-signal.e2e.test.ts` cases
  replacing its T018-era placeholder (6/6): `resolvedAt` set/cleared correctly, the new finder's
  four scenarios, `create`-with-`recurrenceOf` writing both rows atomically, a real reopen and a
  real recurrence proven end to end.
- `make ci`: 49 unit files / 262 tests, 15 e2e files / 120 tests, all gates pass.

## 0.32.0 — 2026-09-27

**001 T020/T021**: `X-Delivery-Id` idempotency — the same batch posted twice is a no-op.

- `packages/domain/issues` gains an `IngestionDeliveryRepository` port (`findByDeliveryId`,
  `recordDelivery`) and an `ingestSignalBatch` application command composing it with T019's
  `enqueueSignalBatch`: an existing `(tenant, provider, deliveryId)` short-circuits to
  `{ accepted: <original count>, duplicate: true }` with nothing enqueued; otherwise the batch
  enqueues first and the delivery is recorded *after* — deliberately, not incidentally (see
  QUESTIONS.md: the reverse ordering risks silently losing a batch if the process dies between
  claiming the delivery and actually enqueueing it, which FR-019 rules out).
- `PrismaIngestionDeliveryRepository` translates the table's own unique-constraint violation
  (P2002) into a port-level `DuplicateDeliveryError` — the database is the actual safety net,
  same precedent as `PrismaNormalisationRulesetRepository.publish`. New
  `ingestion-delivery-repository.e2e.test.ts` (6/6) proves it against real Postgres: tenant-scoped
  reads, a genuine repeat throws, and the same delivery id is never a false duplicate across
  tenants or across providers.
- `IngestController` gained `X-Delivery-Id` (required by the contract) and a stub `X-Provider-Id`
  header — the same TODO-flagged pattern as T019's `X-Tenant-Id`, since nothing in the contract
  names a provider outside the not-yet-real `ingestBearer` credential.
- `apps/api` gained its first `infrastructure/` folder (`infrastructure/prisma.ts`) so `main.ts`
  can construct a `PrismaClient` without tripping the repo-wide "Prisma confined to
  `infrastructure/**`" lint rule.
- `apps/api/ingest.e2e.test.ts` grew from 9 to 13 tests (duplicate delivery, cross-provider
  non-duplicate, missing `X-Delivery-Id`/`X-Provider-Id`).
- `make ci`: 49 unit files / 262 tests, 15 e2e files / 113 tests, all gates pass.

## 0.31.0 — 2026-09-27

**001 T019**: `POST /ingest/signals` — batch ≤ 1000, always `202`, never blocks the provider.

- Enqueue-only: the endpoint validates (`zod`, mirroring `contracts/openapi.yaml`'s `Signal`
  schema) and enqueues one BullMQ job per signal onto the pre-existing `ingestion` queue class
  (012 T015) — it never calls `ingestSignal` itself and never waits on anything downstream.
  `packages/domain/issues` gains a `SignalQueue` port, an `enqueueSignalBatch` application command
  (test-first, 4/4), and a `BullmqSignalQueue` infrastructure implementation. `apps/worker` is
  untouched — the consumer that actually processes queued signals is 001 T024/T025's job.
- Tenant identity is a visible, TODO-flagged stub (`TenantContext.forTrustedInternalUse` read from
  an unverified `X-Tenant-Id` header): no `ingestBearer` credential check exists yet. Chosen via
  explicit user confirmation over building throwaway auth or stopping to design real auth now.
- Two real, previously-undetected bugs found and fixed: `packages/workflow`'s BullMQ wiring
  (012 T015) had never been driven against a real Redis and was missing its required `ioredis`
  client entirely (`bullmq`'s own `peerDependencies`, not an independent choice — added, and named
  in ADR 0003); and Express's default 100kb JSON body limit would 413 a legitimate near-cap batch
  before the DTO's own 1000-item cap ever ran (raised to 5mb via `useBodyParser`).
- `gate-isolation` gained a second recognized helper, `assertTenantScopedEnqueue`
  (`test/tenant-isolation.ts`): the existing `assertTenantIsolated`'s "read back, expect 404"
  contract doesn't fit a write-only endpoint with nothing to read back. Proves isolation by
  embedding a unique marker in each tenant's write and asserting the marker only ever resolves
  back to the tenant that wrote it — real proof, not a presence filter.
- `apps/api/ingest.e2e.test.ts`: first real consumer of `test/containers.ts`'s `startRedis()`
  (9/9) — a real Nest HTTP server against a real Redis, not a fake `SignalQueue`.
- **Opus code review found four more real bugs before this shipped**, all fixed and re-verified:
  - `queue.add()` against an unreachable Redis hung forever rather than rejecting — confirmed
    empirically (>15s unresolved), since `Queue.add`/`addBulk` await the client reaching `'ready'`
    and ioredis's default retry strategy never gives up. `BullmqSignalQueue` now wraps its own
    call in a 3s timeout (`SignalQueueUnavailableError` → the controller returns `503`, not a hang
    or an opaque `500`); `createQueue` also sets `enableOfflineQueue: false` so a command issued
    during an outage can't fire later, after the caller has already been told it failed.
  - `SignalQueue.enqueue` took one signal at a time; `enqueueSignalBatch` called it N times via
    `Promise.all` — a failure partway through left some signals enqueued and the caller seeing the
    whole request as failed, and a naive retry (no idempotency key until T020/T021) would
    double-enqueue the part that had already landed. Changed the port to `enqueueBatch`, backed by
    BullMQ's `addBulk` (one pipelined round trip instead of N).
  - `z.string().datetime()` rejected a valid RFC 3339 timestamp with a timezone offset, accepting
    only a literal `Z` — fixed with `{ offset: true }`. `.strict()` on the signal/error-signature
    schemas turned any provider-added field into a 400 for the whole batch — removed; the field is
    now dropped, not rejected. Both violate FR-019 ("must not lose events") when triggered.
  - `assertTenantScopedEnqueue`'s first version took `_app`/`_method`/`_path` but never used them
    — a caller-supplied `writeAs` could exercise anything, so `gate-isolation` recognizing the
    call proved nothing about what it actually did. The helper now performs the request itself
    against the three arguments it's given.
  - Also: the DTO's `.max(1000)` and `enqueueSignalBatch`'s `MAX_SIGNAL_BATCH_SIZE` were two
    copies of the same limit (the DTO now imports the constant, so `SignalBatchTooLargeError` is
    reachable from this endpoint rather than permanently dead code behind the DTO's own check);
    and every signal in a batch got its own random correlation id instead of sharing one per
    request — the controller now wraps the handler in `withCorrelation`.
- `make ci`: 48 unit files / 257 tests, 14 e2e files / 103 tests, all gates pass.

## 0.30.0 — 2026-09-27

**001 T015**: SC-001 at real scale — replay 12,000 signals from two providers, confirm they
collapse to one issue.

- `ingest-signal.e2e.test.ts` replaces the 200-signal placeholder T018 left explicitly deferred
  ("12 000 is SC-001's own number ... not re-replayed literally here") with the literal scenario.
  Two providers modeled as genuinely different raw shapes for the same failure — a UUID request id
  vs. a memory address plus a bare line number — that both normalise to the identical fingerprint
  under `DEFAULT_NORMALISATION_RULES`, proving cross-provider convergence rather than
  literal-duplicate replay.
- 12,000 sequential awaits would take ~20+ minutes at the existing per-signal cost. Instead the
  first signal runs alone (sidestepping the already-documented, unfixed check-then-act race on a
  brand-new fingerprint's very first arrival), then the remaining 11,999 fire in concurrent batches
  of 25 — safe because `recordOccurrence`'s atomic `GREATEST`/`LEAST` update is already proven
  race-safe. Runs in ~21-37s depending on host contention.
- Found two real bugs while building this: a batch size of 50 concurrent transactions measurably
  exceeded Prisma's default connection pool/`maxWait` once run alongside the rest of the e2e suite
  ("Transaction API error: Unable to start a transaction in the given time") — fixed with an
  explicit `connection_limit` and longer `maxWait`/`timeout` for this one heavy test's client, and
  the batch size lowered to 25. And the first attempt at the "two providers" test data had a
  literal `"req="` prefix that no normalisation pattern strips, silently diverging the two
  providers into different fingerprints — caught by the test itself (exactly half the expected
  count) before it ever needed a debugger.
- `make ci`: 47 unit files / 252 tests, 13 e2e files / 94 tests. The pre-existing, documented
  `issue-repository.e2e.test.ts` concurrency flakiness (QUESTIONS.md) is unrelated to this task —
  T015's own new test passed cleanly in every run this session, including three full `make ci`
  passes where that other, unrelated test failed.

## 0.29.0 — 2026-09-27

**Deep review of 001 T011–T018** (fingerprint normalisation, the issue state machine, the
outbox's first real backing store) — 7 real bugs found and fixed, reproduced against a live
Postgres before and after, one test left honestly red pending further investigation rather than
retried into a false green.

- `transition()` let two concurrent transitions from the same state both commit (both
  `detected -> merged` and `detected -> investigating` are legal edges; a READ COMMITTED guarded
  `UPDATE` measurably still let both through). Fixed with `SERIALIZABLE` isolation — Postgres's
  own conflict detection, not hand-rolled lock ordering — plus the state-guarded `UPDATE` kept as
  a second, independent check.
- `recordOccurrence`'s read-compare-write let `lastSeenAt` move backwards under concurrent
  signals (9/20 reproduced) and never let `firstSeenAt` move earlier. Fixed with `GREATEST`/
  `LEAST` inside one atomic `UPDATE`.
- `create` wrote no `issue_event` for the signal that created the issue, leaving
  `occurrenceCount` and the timeline's `signal_received` count permanently one apart. Fixed.
- The outbox's `claimUnpublished` was an unlocked `findMany` ordered by `occurred_at` alone — two
  concurrent drain workers could double-publish, and a permanently-failing event blocked every
  event behind it forever (reproduced: 5 failed attempts on the oldest row, the next never
  tried). Fixed with a `claimed_at` column and `SELECT ... FOR UPDATE SKIP LOCKED`, ordered by
  `attempts` first so a poison event sinks behind fresher ones instead of starving them.
- Fingerprint hashing joined fields/frames with a raw NUL separator — a frame containing a NUL
  byte was indistinguishable from two separate frames split at it. Fixed by hashing structured
  JSON. Also fixed in the same pass: case-insensitive pattern matching was documented but not
  implemented; R-01's "top frames" was hashing every frame (now capped at 5, a placeholder
  pending real tuning); patterns were recompiled per field instead of once per signal.
- A ruleset with an uncompilable regex, or missing `stripPatterns` entirely, could be published
  and would only fail once `resolveFingerprint` read it back, breaking all ingestion. Fixed with
  a validating `publishNormalisationRules` wrapper, keeping the repository's own `publish`
  generic (its e2e test legitimately publishes non-fingerprint shapes to prove the opaque-storage
  contract).
- The new outbox claim index accidentally dropped the table's required tenant_id-leading index —
  caught by the migration e2e suite's own check; restored alongside the new partial index.
- **Left unresolved, documented in QUESTIONS.md rather than papered over**: the concurrent-
  transitions regression test still fails intermittently in its own file, despite the underlying
  fix reproducing as airtight (0/400+) in every clean-room isolation built while investigating —
  including the same fix with retry enabled, which failed all 4 attempts together, ruling out a
  simple per-attempt race and pointing at something set once per process.
- `make ci` green cold-cache: 47 unit files / 252 tests, 13 e2e files / 94 tests, all 16 gates.

## 0.28.0 — 2026-09-27

**001 T018**: fingerprint computation and attachment of matching signals to the open issue
(FR-002). `ingestSignal` composes T016/T017's pure fingerprinting with two new
`IssueRepository` methods.

- `findOpenByFingerprint`: T002's own fingerprint index, narrowed to `state not in
  ('resolved','merged','removed')` — FR-002 says "the same **open** issue"; a match on a
  resolved issue deliberately does not attach here, that decision belongs to 001 T022
  (reopen/recurrence).
- `recordOccurrence`: increments `occurrenceCount`, advances `lastSeenAt` to the later of the
  two (never backwards, R-10), writes an `issue_event` of type `signal_received` in the same
  transaction. No match creates a new issue via T012's `create`.
- **Test first**: `issue-repository.e2e.test.ts` gained 6 cases (14/14 total);
  `ingest-signal.e2e.test.ts` is new (5/5) — no-match create, attach-and-advance, 200 replayed
  signals collapsing to one issue with the exact count (SC-001's arithmetic — the literal
  12 000 is T026's load characteristic, not re-replayed here), a distinct exception type
  creating a separate issue, and a resolved-only match creating a new issue rather than
  silently attaching.
- Three real judgment calls, flagged in `QUESTIONS.md` for review rather than buried: the
  `kind`/`severity` defaults this path uses (no spec text pins either down), `componentId`
  staying `null` until 004 (architecture-graph) exists — fingerprinting on the raw component
  string meanwhile, with a real (if narrow) consequence once 004 lands — and a check-then-act
  race on a fingerprint's very first arrival, left for 001 T026's load check to notice if it
  matters, with a one-migration fix already identified (a unique partial index).
- `make ci` green cold-cache: 87 e2e tests, all 16 gates.

## 0.27.0 — 2026-09-27

**001 T016/T017**: fingerprint normalisation, and computing it against the real
`normalisation_ruleset` (R-01, FR-003). First tasks of Phase 3 (US1) — genuine product logic,
not infrastructure.

- `fingerprint.ts`'s `computeFingerprint`: a pure hash over `component`, `environment`,
  normalised `exceptionType`, normalised `frames`, normalised `endpointTemplate` and `errorCode`.
  Normalisation is a data-driven, ordered list of regex patterns (`NormalisationRules.stripPatterns`,
  matches replaced with `*`) — the rule set 001 T011 versioned as data now has a concrete shape,
  deferred from that task on purpose. `fingerprint.test.ts`, 6/6: identical across differing
  UUIDs, addresses, generated-file line offsets, timestamps and numeric URL segments; distinct
  across exception type, component and environment; deterministic for repeated calls.
- `resolve-fingerprint.ts`'s `resolveFingerprint` computes it against whichever ruleset is
  **actually published** (`getLatest()`), never a hardcoded default — a fallback here would let
  `issue.ruleset_version` name a version that isn't real, exactly what T011's FK exists to
  prevent. Refuses with a clear error rather than fabricating: no ruleset published yet, or a
  published row whose `rules` column isn't the expected shape. `resolve-fingerprint.test.ts`, 4/4.
- `make ci` green cold-cache: 76 e2e tests, all 16 gates.

## 0.26.0 — 2026-09-27

**001 T014**: tenant scoping on every repository method — a query without `TenantContext` fails
to type-check (FR-015, 012 T010). Phase 2 (Foundational) is now complete.

- Already true by construction: every 001 repository method built so far takes 012 T010's
  `TenantScoped<W>` (unexported brand, `scope()` the sole producer), never a plain filter.
  `NormalisationRulesetRepository` is the one deliberate exception — its table has no `tenant_id`
  column at all (001 T011: one ruleset governs every tenant).
- This task's job was proving the claim, not building new code: `repository.test.ts` for both
  `packages/domain/issues` and `packages/domain/evidence`, plus `link-repository.test.ts` —
  each a real (never-invoked) stub of the interface with `@ts-expect-error` on every method,
  checked by `tsc --build` (which fails with "unused directive" the day any method stops
  requiring `TenantScoped`). Stronger than `packages/shared`'s existing `tenancy.test.ts`, which
  only proves the primitive against a stand-in function, not a real repository interface.
- `make ci` green cold-cache: 76 e2e tests, all 16 gates.

## 0.25.0 — 2026-09-27

**001 T013**: outbox publishers for the events in contracts/events.md (FR-014, 012 T012).

- 012 T012 built only the pure `enqueue`/`drain` logic; there was no Prisma-backed table anywhere
  in the codebase. Closed that gap: `events.outbox` (migration `20260927030000`, a new schema —
  documented in 012's own data-model.md, which had never recorded the table at all) plus
  `PrismaOutboxTransaction`/`PrismaOutboxStore` (`packages/events/src/infrastructure/`).
- Wired for the four events with a real producing operation today: `IssueDetected` /
  `IssueStateChanged` (001 T012's `create`/`transition`) and `EvidenceRecorded` /
  `EvidenceDetached` (001 T006's `record`/`detach`) — each repository method now runs inside
  `$transaction`, so the outbox row commits or rolls back with the mutation it describes, never
  published after the fact from application code.
- `correlationId` comes from `@healer/shared`'s ambient `currentCorrelationId()`, never invented
  per event — its own doc comment already warns that minting one here would fake a second trace
  for the same work. Publishing outside a correlated scope throws.
- Real gap found and fixed while landing this: the event builders (`events.ts` in both
  `packages/domain/issues` and `packages/domain/evidence`) had only e2e coverage, which
  `gate-coverage-completeness`'s unit-only (`all: false`) report cannot see — a change that broke
  one silently would have passed `make test-unit`. Added proper unit tests for both.
- The other seven contract events (`IssueReopened`, `IssueRecurred`, `IssueRelated`,
  `IssueMerged`/`Unmerged`, `IssueStale`, `IssueResolved`, `IssueDeleted`) have no producing
  operation yet and are not wired — flagged in `QUESTIONS.md`, wired when the task that builds
  each operation lands (T018, T049, T051, T053 and friends).
- `make ci` green cold-cache: 76 e2e tests, all 16 gates.

## 0.24.0 — 2026-09-27

**001 T012**: `domain/issues` — `Issue`, the persisted state machine over data-model.md's nine
states, every transition recorded with its cause (FR-006).

- "Built on 012's workflow machine" means the same *technique* as
  `packages/workflow/src/machine.ts`'s `step()` — a closed graph is the authority on what may
  happen next, not the caller, and a pure function returns the new state plus the event —
  deliberately not the same `WorkflowState` union: `awaits`/`jobBudgetMs` exist so a *job* cannot
  hang with nothing to wake it (ADR 0003), a concern `issue.state` does not have (C-14).
- `state-machine.ts`'s graph is exactly data-model.md's diagram: `removed` the only fully
  terminal state, `merged` reaching only `removed`, every other state reaching `merged`/`removed`
  unconditionally alongside its own edges. **Test first**, pure unit test, 11/11
  (`state-machine.test.ts`).
- `PrismaIssueRepository` (`packages/domain/issues`'s first real infrastructure code):
  create/read/`transition` only — `transition` validates against the pure machine first (a
  rejected move never touches the database), then writes the new `state` and the `issue_event`
  recording its cause in one transaction. `issue-repository.e2e.test.ts`, 7/7, including 001
  T011's FK (an unpublished `ruleset_version` is rejected) and `NotFoundError` rather than leaking
  cross-tenant existence.
- Left open, flagged in `QUESTIONS.md`: whether a new matching signal should also revive a
  `stale` issue back to `investigating` (today only `resolved` has a reopen edge) — 001 T018's
  call, not this task's to make ahead of it.
- `make ci` green cold-cache: 75 e2e tests, all 16 gates.

## 0.23.0 — 2026-09-27

**001 T011**: `normalisation_ruleset` as versioned data, the two guarantees the task actually asks
for (R-01, FR-003). The table existed from earlier scaffolding; nothing enforced "a fingerprint
records the version that produced it" or "never edited" yet.

- `issue.ruleset_version` gained a foreign key to `normalisation_ruleset.version` (migration
  `20260927020000`) — before this it was a plain int a caller could invent, not a guarantee.
  `normalisation_ruleset` also gained the same append-only trigger 001 T003 built for
  evidence/audit_entry, matching data-model.md's own "never edited" text. **Test first**:
  UPDATE/DELETE/TRUNCATE rejected, the FK rejecting an unpublished version, 7/7
  (`normalisation-ruleset.e2e.test.ts`). One real subtlety the first draft missed: a plain
  `TRUNCATE` on this table is already rejected by Postgres's own referential-integrity check
  (`issue.issue` references it) before the trigger ever runs — proving the *trigger* itself works
  needed `TRUNCATE ... CASCADE`, not a plain one.
- `PrismaNormalisationRulesetRepository` (`packages/domain/issues`, this package's first real
  code): read plus publish only, no update — `publish` always mints the next version, matching
  the same "don't expose the shape" pattern `EvidenceRepository` already uses. 6/6
  (`normalisation-ruleset-repository.e2e.test.ts`).
- Adding the FK required inserting a real `normalisation_ruleset` row in four existing e2e tests'
  `beforeAll` blocks — they had been inserting `issue.ruleset_version = 1` against a version that
  never existed as a row, which the FK now correctly catches.
- `rules` stays untyped (`Json`/`unknown`) on purpose — its concrete shape (which fields strip
  identifiers, timestamps, memory addresses, URL segments) is T017's design, not this task's to
  invent ahead of it.
- `make ci` green cold-cache: 68 e2e tests, all 16 gates including the schema-drift check
  (`prisma migrate diff` empty against the updated `schema.prisma`).

## 0.22.0 — 2026-09-27

**001 T009–T010**: no conclusion without evidence (FR-009, quickstart 9) — the last of Phase 2's
three foundational guarantees (append-only, producer attribution, this one).

- **Found and resolved a real design conflict between 012 and 001, not a detail**: `gate-evidence`
  (012 T031, built before 001 existed) checked a conclusion model for a single non-nullable
  `evidenceId` column. 001's actual data model has no such column — `evidence_link` is a
  many-to-many join keyed by `(conclusion_type, conclusion_id)`, since a conclusion can have
  several supporting links and a piece of evidence can support several conclusions. Rewrote
  `gate-evidence` to check what a static schema scan actually can — that a `@conclusion <type>`
  tag names a real `ConclusionType` value, the list's one authority — and left the genuinely
  runtime question (does this conclusion actually have a link) to the new `assertHasEvidence` and,
  later, `check:evidence-coverage` (SC-002, T033).
- `assertHasEvidence` (`packages/domain/evidence/src/domain/evidence-required.ts`): depends only
  on `EvidenceLinkRepository`'s interface, throws `EvidenceRequiredError` — quickstart 9's
  `EVIDENCE_REQUIRED` — when a conclusion has zero links. `EvidenceLinkRepository` gained the one
  read method it needed (`hasLinks`) alongside the existing write-only `write`.
- Verified against a live Postgres: a conclusion with no links rejected, one with a real link
  passes, and one conclusion's link is never confused with another's of the same type, 3/3.
- `make ci` green cold-cache: 38 unit files / 215 tests, 8 e2e files / 55 tests, all 16 gates.

## 0.21.0 — 2026-09-27

**001 T007–T008**: producer attribution on `evidence_link` (FR-008, R-06) — "a link created by a
step other than the one that observed the fact is detectable," enforced independently at the
database and at the repository, same pattern as the append-only guarantee.

- New migration `20260927010000_step_attribution` (not an edit to the already-pushed 001
  migration — that's now closed off by the standing rule in `.claude/rules/prisma-migrations.md`):
  a `BEFORE INSERT` trigger on `evidence_link` rejects a row whose `asserted_by_step` doesn't
  match `healer.current_step`, a transaction-local `set_config` value (same scoping as
  `healer.privileged_write`). No step declared at all is rejected too — an anonymous write has no
  attribution to falsify. `step-attribution.e2e.test.ts` proves all three cases against a live
  Postgres, 3/3.
- `@healer/shared` gained a `step-context` module: `withStep`/`currentStep`, an `AsyncLocalStorage`
  shaped exactly like the existing `withCorrelation`/`currentCorrelationId`. `PrismaEvidenceLinkRepository.write`
  reads the ambient step and refuses before ever touching the database if none is set.
- `NewEvidenceLink` has no `assertedByStep` field — not unused, structurally absent, so the
  "attributed to a different step" scenario the database rejects isn't expressible through the
  repository at all, only through raw SQL bypassing it entirely. `evidence-link-repository.e2e.test.ts`
  proves the legitimate `withStep(...)` path and that two different steps are each attributed to
  themselves, 3/3.
- `make ci` green cold-cache: 37 unit files / 213 tests, 8 e2e files / 52 tests, all 16 gates.

## 0.20.0 — 2026-09-27

**001 T006**: the append-only evidence repository — `PrismaEvidenceRepository`, the first real
`@prisma/client` consumer anywhere in this codebase (FR-010, R-03).

- `packages/domain/evidence/src/infrastructure/prisma-evidence-repository.ts`: write and read
  only — `record`, `findById`, `detach` — no generic `update`, so the one legitimate mutation
  (`ref_state` moving `linked` to `detached`) has no method shaped to reach any other field.
  Tenant scoping through the composite `(id, tenantId)` key inside the query itself (Prisma's
  `id_tenantId` compound unique input), never a post-fetch check; `detach` translates Prisma's
  "no row matched" into `@healer/shared`'s `NotFoundError` rather than leaking a raw persistence
  error up through the domain interface.
- **ADR 0013**: a dedicated `@healer/prisma-client` workspace package. `prisma/schema.prisma`'s
  custom generator `output` means the generated client is its own self-contained package, not
  `node_modules/@prisma/client` — and not a plain relative import either, since it sits outside
  every package's `rootDir`. One small package re-exports it via pnpm's `link:` protocol
  (`@healer/prisma-generated`) so all twelve future `packages/domain/*` repositories depend on one
  stably-named workspace package instead of each carrying its own `link:` path to a build
  artifact three directories up. The existing `@prisma/client`-confined-to-`infrastructure/**`
  eslint rule now covers `@healer/prisma-client` too, closing what would otherwise have been a
  two-character bypass of the boundary it exists to enforce.
- Verified against a live Postgres (`evidence-repository.e2e.test.ts`, repo root — the same
  rootDir constraint that put T004's test there): record-then-read for the owning tenant, `null`
  for another tenant's lookup of the same id (proving the query itself is scoped, not filtered
  after the fact), `null` for an id that never existed, `linked → detached` leaving every other
  field untouched, `NotFoundError` on a wrong-tenant `detach`, and the composite FK (T006's own
  prerequisite work, this session's earlier review-fix round) rejecting evidence recorded against
  another tenant's issue. All 6 passed on the first real run.
- **Two more real bugs found only by actually running the gates, not by reading the diff**:
  `deps-check`'s ADR-diff check was requiring an ADR for any brand-new *internal* `@healer/*`
  dependency edge between our own packages — FR-006 governs external dependency risk (licensing,
  supply chain), not internal architecture wiring, so this is now excluded the same way the
  allowlist check already excludes `@healer/*`. And a genuine vitest/v8-coverage bug: a workspace
  package resolves to its *built* `dist/index.js` when imported by name from another package, but
  to live-transformed `src/index.ts` when imported by relative path from within its own package —
  two different scripts to v8, both remapped to the same reported source path, whose coverage
  entries concatenate instead of summing. `packages/shared/src/tenancy/index.ts` dropped from
  100% to 83% function coverage with zero lines of that file touched, purely from a new consumer
  importing `NotFoundError` by package name for the first time from outside its own package.
  Fixed by aliasing every workspace package name to its own `src/index.ts` in each vitest
  project's `resolve.alias` — a root-level `resolve.alias` silently does nothing under
  `test.projects`, it has to be declared per project.
- **`infrastructure/**` excluded from the unit coverage floor** (documented in `QUESTIONS.md` as a
  real, reversible-if-wrong decision): a repository's actual guarantees are only meaningful
  against a live database, and `test-unit`/`test-e2e` run as two separate `vitest run`
  invocations that never merge coverage — so the gate for this class of code is `make test-e2e`
  passing, not a unit-coverage percentage that would just get gamed with shallow mocked-client
  tests. The database-level append-only enforcement (001 T003) is an independent, DB-level
  backstop for the one property this trade-off matters most for, regardless of what the
  repository's TypeScript does.
- `make ci` green cold-cache: 35 unit files / 207 tests, 6 e2e files / 46 tests, all 16 gates.

## 0.19.0 — 2026-09-27

**001 T005**: `packages/domain/evidence`'s first real code — `Evidence` and `EvidenceLink` domain
types, and excerpt bounding at capture (R-05, FR-011).

- `Evidence`'s `excerpt`/`excerptTruncated` pair is a discriminated union
  (`{ excerpt: null; excerptTruncated: false } | { excerpt: string; excerptTruncated: boolean }`),
  not two independent fields — the same technique 012's `WorkflowState` uses to make an illegal
  combination (`excerptTruncated: true` with nothing actually captured) unrepresentable rather than
  merely unexpected, which matters here because a misleading truncation claim is exactly the kind
  of unsupported claim the constitution's Evidence First principle exists to prevent.
- `boundExcerpt(raw, maxLength)`: beyond the limit, a head-and-tail extract replaces the full text
  and `excerptTruncated` is marked (R-05's decision — "nobody reads the middle of it"). Slices by
  Unicode code point via `Array.from`, not by UTF-16 code unit via `String.slice`: a multi-byte
  character (an emoji in captured log text) landing on the cut boundary is dropped whole rather
  than split into a lone surrogate that later fails to round-trip through Postgres/JSON as valid
  UTF-8 — a real-input correctness concern for arbitrary captured text, not a hypothetical one.
  `maxLength` is a parameter, not a constant: FR-011/spec.md's assumptions call the excerpt limit
  configuration, tuned on the stage-0 incident audit, which has not run yet.
- `EvidenceType`, `RefState`, `ConclusionType` and `EvidenceRelation` are mirrored here as plain
  string unions rather than imported from `@prisma/client`'s generated enums — domain code cannot
  import that package (infrastructure-only, 00-core.md), so the closed lists are declared twice by
  necessity; a mismatch will surface the moment the repository (T006) tries to persist a value
  neither side recognises. `Evidence.payload` is typed as a loose `Readonly<Record<string,
  unknown>>` for now — mapping it to `packages/boundary-contract`'s `RunnerEvidence` union turned
  out not to be 1:1 (`Evidence.type` has 12 values, `RunnerEvidence.kind` has 23, and two of the
  twelve — `document_excerpt`, `budget_degradation` — have no corresponding wire shape at all yet);
  reconciling that mapping is T027's job ("validated against 012's boundary schemas"), not T005's.
- **A real, previously-unnoticed bug in `gate-coverage-completeness` (shipped in 0.18.0), found by
  using it for the first time on new code**: a pure type-only file (`types.ts`, only `export type`/
  `export interface`) or a barrel re-export (`index.ts`, only `export * from`) compiles to zero
  v8-instrumentable statements — the gate was flagging both as "no test exercises this file at all"
  regardless of whether anything imported them, since there is structurally nothing there for v8 to
  ever assign coverage to. Every domain package in this spec will have exactly this shape, so left
  unfixed this would have permanently blocked `make ci` the first time any domain package grew real
  types. Fixed by broadening the exemption from "is exactly the `export {}` FR-001 stub" to "the
  stripped content contains no runtime-declaration keyword (`function`/`class`/`enum`/`const`/
  `let`/`var`)" — verified it still catches a synthetic untested real-logic file (a bare `export
  function`) before removing the test fixture.
- `make ci` green cold-cache: 34 unit files / 198 tests, 5 e2e files / 38 tests, all 16 gates.

## 0.18.0 — 2026-09-27

**Deep review (a second, independent pass) of everything since 0.9.0 — 15 findings, 14 code fixes
verified against real failures, 1 recorded decision.** No new functionality. Every fix was
reproduced as an actual failing test or a real command run first, then re-verified after, not
accepted from reading the diff alone.

- **Tenant isolation, closed the gap for real** (FR-048): `Evidence`, `IssueRelationship` (both
  sides), `IssueEvent` and `WorkflowCallback` now carry composite foreign keys against their
  parent's `(id, tenantId)`, not just `id` — a row naming another tenant's issue, run or evidence
  is rejected by Postgres, not merely mis-indexed. `Evidence` gained a hard FK to `Issue` it did not
  have before (reverses the call recorded in `QUESTIONS.md`: the tenant-isolation guarantee and
  `evidence`'s package independence turned out to be orthogonal — a DB-level FK creates no
  TypeScript dependency). `ingestion_delivery`'s idempotency key is now unique per
  `(tenant_id, provider, delivery_id)`, not globally per `(provider, delivery_id)` — two tenants
  using the same webhook provider could otherwise collide on each other's delivery ids.
- **Append-only had a real gap**: `schema.prisma` claimed "the append-only enforcement pattern
  covers every immutable table," but `workflow_transition` had no trigger at all — added, plus a
  regression test that proves it. Every append-only table also gained a `BEFORE TRUNCATE`
  statement-level trigger: row-level `BEFORE UPDATE OR DELETE` triggers do not fire on `TRUNCATE`,
  so that was a silent bypass nothing had exercised. The `SET LOCAL` (never bare `SET`) requirement
  for the privileged-write bypass is now spelled out at the point future retention/deletion code
  (T052/T053) will need to get it right.
- **Runner protocol boundary hardened** (`packages/boundary-contract`): the capability handshake's
  90-day protocol floor was ageing the *current* version by its own release date — meaning every
  runner still on the current version would eventually be refused with nothing newer to upgrade to.
  Fixed to age only a *superseded* version, from its successor's release date. `agentDirective`'s
  `inputRefs` is now `.strict()` (an unrecognized key silently vanished before, rather than failing
  loud like every other shape in this contract). `toolOutputSummary.fields` is now bounded — 500
  characters per value, 20 keys — closing the one shape in the evidence contract that could
  otherwise smuggle an arbitrarily large raw log excerpt under a plausible-looking field name.
  `OutboundBuffer`'s gap log is now bounded the same way its item buffer already was; a sustained
  outage could previously grow the gap array without limit.
- **`runWithBudget` now actually cancels**: a job that outran its wall-clock budget used to just get
  raced and abandoned — the underlying work kept running unobserved, so a late side effect could
  still land after the job had already been recorded as timed out. `runWithBudget`/`runJobWithBudget`
  now pass an `AbortSignal` through to the job function that fires on breach, so cooperative work
  (fetch calls, polling loops, spawned processes) actually stops.
- **Two CI gates were checking less than they claimed**: `changed-files.mjs` documented itself as
  "fails closed (R-10)" but silently treated "no base ref resolves at all" as "nothing changed" —
  now throws, with a test proving it. `deps-check` had its own second, drifted copy of the same
  base-ref resolution (falling back to `HEAD`, which defeated its own ADR-diff check by comparing
  the working tree to itself) — consolidated onto the one in `changed-files.mjs`; it also only ever
  read `dependencies`, so a new package added under `devDependencies` skipped both the allowlist and
  the ADR-in-the-same-change-set check entirely — now checks all four dependency fields.
  `gate-isolation` counted a commented-out or `it.skip`'d `assertTenantIsolated(...)` call as real
  coverage, since it matched the call by regex against raw source text; now strips comments and the
  full body of any `.skip(...)` call before scanning (`stripComments` shared with
  `gate-architecture-agnostic`, which had the same helper duplicated locally).
- **New gate: `gate-coverage-completeness`.** `vitest.config.ts`'s `coverage.all: false` (deliberate:
  it stops the many still-empty scaffold packages from sinking the global 80% floor) has a side
  effect nothing was checking for — a brand-new file under a 95%-floor path (`packages/domain/policy`,
  `packages/domain/evidence`, `packages/shared/src/tenancy`, `packages/agents/src/output`) that no
  test imports at all never appears in the coverage report, so it cannot fail a threshold it is
  invisible to. The new gate walks those four directories directly and fails if any file with real
  logic (more than an `export {}` entry surface) is missing from the coverage summary. Verified
  against a synthetic untested file before removing it — the gate caught it — and the current tree
  passes clean.
- **A test was silently allowed to delete real source**: `eslint-never-wait.e2e.test.ts`'s fixture
  directory pointed at `packages/workflow/src/processors/`, the real production directory, not a
  scratch one — a failed cleanup step could have deleted shipped code. Scoped to a
  `__never_wait_fixture__` subdirectory instead.
- **Lint**: the `process.env` restriction pattern and message pointed at a path
  (`packages/shared/config/**`) that does not exist — the real one is
  `packages/shared/src/config/**` — and its selector missed a destructured or bare read of
  `process.env`, only catching `process.env.X`. Both fixed, with tests for the destructured and bare
  cases. The cross-package relative-import rule (`../../*` depth patterns) was removed rather than
  patched: proven, via a deliberately constructed same-package-deep-import fixture, that no
  depth-based glob can tell "reaches into a foreign package" apart from "a legitimately deep file in
  this same package" — the real guarantee is already structural, from T002's `moduleResolution:
  NodeNext` making a relative import that escapes a package's `rootDir` a compile error.
- **Recorded, not fixed**: this session continued editing an already-committed migration
  (`20260924120000_init_foundation`) rather than opening a new one, for the reasons and the hard
  stop condition written up in `QUESTIONS.md` under "Deep review round 2."
- **`make ci` itself caught a bug this pass introduced**: `db-check`'s irreversible-migration check
  matches the bare word `TRUNCATE` anywhere in a migration's SQL, which flagged the new
  `BEFORE TRUNCATE ON ...` triggers above — a trigger that *prevents* a truncate is the opposite of
  a destructive statement, and a `-- TRUNCATE bypasses...` prose comment tripped the same check for
  the same reason: no comment stripping, and SQL's `--` line comments aren't JS's `//` (the existing
  shared `stripComments` helper doesn't apply). Fixed with a negative lookahead
  (`TRUNCATE(?!\s+ON\b)`) excluding the trigger-event usage and a SQL-specific comment stripper —
  found and fixed only because `make ci` was actually run cold-cache rather than trusted from the
  unit suite alone.
- `make ci` run cold-cache, end to end, all 16 gates green: 187 unit tests (99.15% line coverage)
  across 33 files — four new suites (`coverage-completeness.test.ts`, plus two new false-positive
  regression cases in `db-check.test.ts`) and expanded coverage in `outbound-buffer`, `job-budget`,
  `isolation`, `deps-check`, `changed-files` — and 38 e2e tests across 5 files, including
  `append-only.e2e.test.ts` at 10/10 (up from 7) and `prisma/migration.e2e.test.ts` at 8/8, both
  against a live Postgres after the composite-FK schema changes.

## 0.17.0 — 2026-09-27

**001 issue-and-evidence begins: T001–T004, the schema and the append-only guarantee — the
constitution's Principle I ("Evidence First"), proven at the database, not asserted in a
repository docstring.**

- **Schema** (T002): `issue`, `evidence` and `audit` — `Issue` (9-state machine, fingerprint +
  ruleset version, a partial fingerprint index that excludes only `merged`/`removed`),
  `IssueRelationship` (the single store for `related`/`recurrence_of`/`merged_into`, with the
  two partial unique indexes that cap the single-valued kinds at one live row each), `IssueEvent`
  (domain facts, deliberately not unioned with 012's `workflow_transition` — different grains),
  `IngestionDelivery` (the idempotency key), `NormalisationRuleset` (versioned, global — the same
  shape as 012's `prompt_version`), `Evidence`, `EvidenceLink`, `AuditEntry`, `DeletionTombstone`.
  A new migration (`20260927000000_issue_evidence_audit`), not an edit to 012's — enough time and
  a real second feature separate them to make that the honest choice, and it exercised the
  multi-migration apply/reverse logic Phase 3 built for exactly this.
- **Caught by the migration e2e suite on its first real run against this schema**: a stray
  `'closed'` `Issue.state` value in `data-model.md` that appears nowhere in the actual 9-state
  enum (dispatched a research pass before writing the Prisma enum rather than trusting one
  ambiguous line; fixed the doc to `state not in ('merged', 'removed')` — logged as a judgment
  call in `QUESTIONS.md`, since which terminal states should drop out of the fingerprint index
  isn't fully spelled out anywhere), and two tables missing their required tenant-leading index
  (`evidence_link`, `deletion_tombstone`) — the same class of gap that broke `workflow_transition`
  back in phase 3, caught the same way: by actually running the check, not by re-reading the code.
- **Append-only enforced by Postgres triggers, not application discipline** (T003, R-03):
  `evidence_link`, `issue_event` and `audit_entry` reject every `UPDATE`/`DELETE` unconditionally;
  `evidence` additionally permits exactly one transition, `ref_state: linked → detached`, and
  rejects the reverse. A `SET LOCAL healer.privileged_write = 'on'` session GUC is the one
  documented bypass, for the retention and tenant-deletion paths (T052/T053, not built yet) —
  every use of it is meant to be its own audited action, never a silent escape hatch.
- **`append-only.e2e.test.ts`** (T004): proves all of the above through raw SQL against a real
  Postgres — tampering rejected, the one legitimate transition allowed, the reverse rejected,
  DELETE rejected, the privileged bypass working, `issue_event`/`audit_entry` fully immutable.
  7 tests, all watched to fail before the triggers existed.
- **Two real, unrelated bugs fixed while building this**: `AgentKind` (012's own enum) was
  missing `test_author`, even though `packages/boundary-contract`'s Zod schema already included
  it from phase 8 (013 R-07) — a real drift between the DB enum and the schema that models it,
  now closed. And `test/containers.ts`'s `stop()` helpers returned `Promise<StoppedTestContainer>`
  against a declared `Promise<void>` — a real type error nothing had ever caught because the file
  had never been part of any `tsc --build` project graph until a new root-level e2e test started
  importing it, which is also what surfaced a real TS project-boundary violation (a test placed
  inside a package's `src/` reaching `test/containers.ts` through a relative path that crosses
  outside that package's `rootDir` — moved to the repository root, matching the established
  pattern for cross-cutting e2e tests).
- `make ci`: 164 unit tests (99.0% coverage) + 33 e2e tests (+7 for the new append-only suite),
  ~27s cold-cache.
- **Checkpointing here.** 001 has 53 tasks left — ingestion and fingerprinting (US1), evidence
  recording and producer attribution (US2), correlation (US3), audit and timeline views (US4–5),
  merge/retention/deletion (Phase 8). Real product logic with genuine design decisions (the
  normalisation ruleset's actual rules, the ingestion API shape), not infrastructure — the right
  place to pause and let this land before going further.

## 0.16.0 — 2026-09-27

**012 phase 12 (analyze-pass additions): 6 of 8 done, plus a real gap the new gate found in
itself and fixed.**

- **`scripts/lib/changed-files.mjs`** — shared base-diff utility for `gate-data-model` and
  `deps-check`'s ADR check. Caught its own bug before it shipped: a naive `<base>...HEAD` commit
  diff sees nothing when the working branch has diverged by zero commits (this repository's
  actual state — everything uncommitted, standing on `master`), so it now unions committed
  divergence with working-tree changes. Tested against real, disposable git repos (init, commit,
  branch, diverge) — not this repository's own transient state, which would break the test the
  moment these changes are committed.
- **`gate-data-model`** (T076): fails when `prisma/schema.prisma` changed with no
  `specs/*/data-model.md` change in the same change set. Attributes to "some spec's data model,"
  not the *owning* one specifically — no table→spec map exists to check that precisely, said
  plainly rather than pretended.
- **Boundary-exception registry** (T077): `linterOptions.noInlineConfig: true` — confirmed
  empirically that an `eslint-disable` comment becomes a no-op and the suppressed rule still
  fires. Repo-wide, not scoped to boundary rules only: ESLint has no per-rule "cannot be disabled"
  switch. `docs/boundary-exceptions.md` is the only recorded form an exception can take now.
- **`deps-check` ADR-diff extension** (T078) — and it immediately did its job on the first real
  run: `@nestjs/swagger`, added back in phase 6, had no ADR, and the gate correctly refused to
  pass. [ADR 0012](docs/adr/0012-openapi-contract-generation.md) written to close the gap
  honestly, not to route around the gate. Also fixed a design flaw before it shipped: the first
  version flagged a dependency as "new" per package.json file, which would have demanded a second
  ADR for `zod` just because `boundary-contract` started using a dependency `packages/shared`
  already had — narrowed to "new to the monorepo," which is what FR-006 actually asks about.
- **`gate-no-send`** (T082): no package outside an (empty, today) egress allowlist may import an
  outbound mail/SMS/chat package. Deliberately monorepo-wide, not scoped to packages named
  "support" — the task's own rationale is that a name-scoped rule is exactly the kind of gap a
  differently-located adapter slips through.
- **T081 confirmed, no new code**: the prompt registry's resolve-by-id-only design (phase 9)
  already makes prompt selection unreachable from a model response.
- **Deferred**: T079 (pgvector rebuild — nothing uses pgvector yet), T080 (operator audit trail —
  needs 001), T083 (`gate-ceiling` — needs 002).
- **Phase 13 (agent-driven development) not started.** Corrected an assumption before acting on
  it: I initially wrote in `QUESTIONS.md` that no GitHub remote was configured — `git remote -v`
  says otherwise (`origin` → `github.com:EverRest/healer.git`). The real reason to stop here:
  T088–T092 install a GitHub App, set branch-protection rules and name real humans in
  `CODEOWNERS` — account-level, security-relevant changes to a shared system that need your
  sign-off, not something "keep going" extends to. T084–T087 (identity resolver,
  `gate-agent-scope`, `gate-red-first`) can be built and tested against local fixture repos with
  no live GitHub interaction, per the task list's own note — ready to start on request.
- `make ci`: 164 unit tests (99.0% coverage) + 26 e2e tests, ~26s cold-cache.

## 0.15.0 — 2026-09-27

**012 phases 8–11 (US6–US9): self-observation, the prompt registry, the BYO fallback trap,
onboarding.** 13 of 19 tasks done; 6 deferred, all landing on the same gap (`packages/llm` is an
empty stub — nothing to resolve a per-tenant provider client *to* yet).

- **`digestToolCallArguments`** (T059): a stable, key-order-independent SHA-256 over tool call
  arguments — `RunnerEvidence.agentRunReport.toolCalls[].argumentDigest` (phase 6) already made
  the raw value unrepresentable in the crossing shape; this computes what it carries.
- **Single-store structural test** (T060): `prisma/agent-run-single-store.test.ts` scans
  `schema.prisma` for any model other than `AgentRun` declaring a prompt-version/token/cost/model
  field. Watched fail on a planted duplicate field in `WorkflowRun`, then reverted — same TDD
  discipline as every other structural gate this phase.
- **Whole-line secret scan added to `createLogger`'s tests** (T062) — caught itself: the literal
  private-key fixture I wrote failed `secret-scan` the moment it was staged, same as
  `secret-scan.test.ts`'s own fixture did in phase 3. Rebuilt from concatenated parts.
- **`packages/prompts`** (T063, T064): content-addressed `publish` — republishing identical
  content is a no-op returning the same identity, changed content is a new version, and there is
  no update function on the module's surface at all, checked by asserting no export name matches
  `/update/i`. `resolveByVersionId` is the only resolver; no `resolveByKey` exists to fall back to.
- **`findByoFallbackViolations`** (T070): the read-side check for the BYO fallback trap, using
  `agent_run.provider` against the tenant's configured provider as a proxy for "used a
  Healer-managed key" — `agent_run` doesn't record which credential was used, only which brand.
- **T069 confirmed, no new code**: `FallbackScope` has had exactly one value since phase 1–2.
- **`make help`** (T072): self-documenting via `##` comments — caught and fixed a real bug in its
  own grep pattern before trusting it: `[a-zA-Z_-]` excludes digits, so `test-e2e` silently never
  appeared in the list.
- **README rewritten, `make bootstrap` re-run for real** (T071), not simulated — confirmed
  idempotent on a second run.
- **Deferred** (T061, T065–T068): cost accounting needs 002/011; eval history needs 011;
  secret-manager integration is a new-dependency/ADR decision I won't make silently; per-tenant
  provider resolution and the BYO-retry test both need a real `packages/llm` provider adapter,
  which doesn't exist. Reasoning in `QUESTIONS.md`.
- **T073 not attempted**: running all 35 quickstart scenarios is 012's final-milestone check, not
  a per-phase task — several scenarios need phases 12–13 and the runner build this phase deferred.
- `make ci`: 150 unit tests (99.0% coverage) + 24 e2e tests, ~22s cold-cache.

## 0.14.0 — 2026-09-27

**012 phase 7 (US5) complete: never wait inside a job.** T052–T058, all seven.

- **The never-wait lint rule** (T052, T053): a processor may not `setTimeout`/`setInterval` or
  `while (true)`-poll. Scoped to `**/processors/**` (no directory exists yet — applies the moment
  one does, no per-package listing) via a *second*, disjoint `no-restricted-syntax` block rather
  than adding to the existing `process.env` block: `no-restricted-syntax` has no TS-specific
  alternate rule name the way `no-restricted-imports` does, and a selector can't test the file
  path itself, so two overlapping blocks would hit the exact same last-one-wins collision T035
  found — documented in both blocks' comments so the next person doesn't reintroduce it.
  `eslint-never-wait.e2e.test.ts` runs the real composed config, confirming both new selectors
  fire, `process.env` is still caught inside `processors/`, and — importantly — a `setTimeout`
  *outside* `processors/` is correctly left alone.
- **`runWithBudget`/`runJobWithBudget`** (T054): races a job against its declared wall-clock
  budget; on breach, logs a structured error (this repo's stand-in for "raises an alert" — no
  dedicated alerting sink exists yet) and rejects with `JobBudgetExceededError` so the caller can
  record the `timeout` transition.
- **T055 needed no new code**: `CallbackKind` (phase 1–2) already names `ci_result`,
  `deploy_result` and `verification_tick` — the long-wait pattern already covers what T055 asks
  for.
- **`findOverdueRuns`/`findStuckRuns`** (T056, T058): the decision logic a scheduled tick will
  call once a repository exists to feed it real rows — same deferred-persistence shape as phase
  6's T042, not duplicated here.
- **T057 needed no new code**: a `WorkflowRun`'s `state` field *is* its resumption point by
  construction (T013) — there is no separate "resume" code path for a restarted worker to run.
- `make ci`: 131 unit tests (99.0% coverage) + 24 e2e tests, ~24s cold-cache.

## 0.13.0 — 2026-09-27

**012 phase 6 (US4) partially landed: the runner protocol's pure logic, not its transport.**
7 of 13 tasks done as real, tested code; 6 explicitly deferred rather than half-built.

- **`packages/boundary-contract`** (T040): the closed evidence/directive shape set from
  contracts/runner-protocol.md as Zod schemas — 23 runner→control-plane shapes, 7 control-plane→
  runner directives, every one `.strict()` so a free-form field is a validation failure, not a
  passthrough. `isPermittedInSimulationSession` encodes C-10's restricted directive set (no
  `remediation_directive`; `agent_directive` only for `change`/`verifier`).
- **The capability handshake** (T039, T043, T044): `resolveHandshake` — active when every
  requirement is met, degraded when a read-only capability is missing, refused when a
  state-changing one is (never the reverse), refused below the two-minor-version or 90-day
  compatibility floor. Full quickstart 17–19 matrix as tests, written and watched to fail first.
- **Independent egress/ingress validation** (T041): two distinct call sites against the same
  schema — the control plane does not trust that the runner's own validation ran.
- **Bounded outbound buffer** (T046): drop-oldest-on-overflow, record a `collection_gap`, never
  truncate an item to make it fit.
- **Redaction mechanism** (T047): exactly two outcomes, clear or withheld — no third "truncated"
  state to reach for. The actual classification policy is 003/005's; this is the shape a real
  policy plugs into.
- **Deferred, not faked** (T042, T045, T048–T051 — runner registration/heartbeat persistence,
  outbound transport, `runner-diagnostics`, `runner-build`/Docker packaging, directive
  idempotency): every one needs a repository/controller pattern or an actual `apps/runner`
  codebase that doesn't exist until 001 establishes the convention. Reasoning in `QUESTIONS.md`.
- `make ci`: 119 unit tests (98.9% coverage) + 19 e2e tests, ~23s cold-cache.

## 0.12.0 — 2026-09-27

**012 phase 5 (US3) complete: boundaries by pattern, not by name list.** T034–T037 done, T038
deliberately left undone (nothing to check yet — see below).

- **ESLint flat-config gotcha caught by its own test, first run.** Four `no-restricted-imports`
  boundary rules (Prisma outside infrastructure, provider SDKs outside their adapter, `process.env`
  outside shared/config, cross-module relative imports) were split across separate config blocks
  for clarity — and two of the four silently never fired: flat config doesn't merge a rule's
  options across matching blocks, the last one for a file wins outright. `eslint-boundaries.e2e.test.ts`
  runs the real composed config against fixture files (012 T034) rather than a synthetic
  `RuleTester`, which is exactly what caught it. Fixed by merging same-key rules into one block
  and giving the cross-module check a distinct rule name (`@typescript-eslint/no-restricted-imports`)
  so it can no longer collide with the others.
- **T035**: the four boundary patterns above. The "cross-module infrastructure" pattern is
  deliberately blunter than the spec's literal wording — a generic ban on relative imports two or
  more `../` levels deep, not specifically infrastructure paths — because the precise version
  already exists structurally (T002, `moduleResolution: NodeNext` + per-package `exports` maps
  reject an undeclared subpath at typecheck) and a sharper lint-time version is its own dependency
  decision (`eslint-plugin-boundaries`), logged in `QUESTIONS.md` rather than added silently.
- **T036**: file/function/complexity/nesting limits, tests exempt. Verified against real
  fixtures, not just declared.
- **T037 `deps-check`**: dependency allowlist, ADR-0004 Postgres extension list, `pnpm licenses
  list --json` for permissive-licence enforcement, `pnpm install --frozen-lockfile` for lockfile
  sync. Confirmed failing on a planted unapproved dependency, then reverted. FR-006's other half —
  a new dependency needs an ADR *in the same change set* — needs base-revision diffing this repo
  hasn't built (Phase 13 territory); not half-built here, logged instead.
- **T038 left unchecked, not faked.** ADR 0008's capability-passing lint pattern protects four
  operations across four specs, none implemented yet — no capability type, no mutating module, no
  privileged-package convention exists anywhere to write a pattern against. Every other
  forward-looking gate this phase had at least an empty real location to check; this one has
  nothing, and a guessed file-naming convention would be a wrong guess dressed up as
  infrastructure.
- Coverage floor genuinely enforced now, not just switched on: fixed a second real gap
  (`TenantContext.forTrustedInternalUse`, in 0.10.1) and scoped `coverage.all: false` so the
  global 80% floor measures code with tests, not the untouched future-spec package stubs. Adding
  CLI wrapper scripts kept dragging the average down as gate scripts accumulated — added `/* v8
  ignore */` around each script's untestable CLI-entry block (real git/fs/subprocess I/O), moving
  the pure logic they wrap back to 100%. Coverage now 98.3%.
- **Caught and fixed while writing gate tests, not shipped**: a copy-pasted `deps` mock in
  `db-check.test.ts` (`const adrExists = (n) => n === '0012'`) locally shadowed the real
  `adrExists` import added minutes earlier in the same file — same identifier, same module scope.
  The first describe block's tests silently exercised the mock instead of the real function and
  still reported a failure (`false` returned instead of `true`), which is what surfaced it; a
  coincidentally-matching mock would have hidden it completely. A reminder that "the test failed"
  is data about the test as much as the code — confirm *which* code ran before trusting either.
- `make ci`: 92 unit tests (98.3% coverage) + 19 e2e tests, ~27s cold-cache.

## 0.11.0 — 2026-09-27

**012 phase 4 (US2) complete: no endpoint or reversible action ships untested.** Five gates, all
watched to fail on a real fixture before being trusted (T028), plus a genuine, previously-latent
bug this work exposed and fixed.

- **The API has never been able to boot until now.** `HealthController`'s constructor took a
  bare object-typed parameter; TypeScript erases that to `Object` for `design:paramtypes`, so
  Nest's DI could not resolve it — `NestFactory.create` failed on every single invocation,
  silently (Nest's default `abortOnError: true` calls `process.exit(1)` before anything reaching
  a catch block gets to run). No test had ever booted the real Nest module — `health.test.ts`
  only called the plain `buildHealthReport` function. Fixed with an explicit `@Inject(HEALTH_META)`
  token; `main.ts` refactored to export `createApiModule(meta)` so both `bootstrap()` and contract
  generation share one module definition instead of two that could drift; a new
  `apps/api/src/main.e2e.test.ts` boots the app for real and hits `/health` and `/ready` over
  HTTP with Supertest. This is exactly what "reproduce before modify" and running things for real
  are for — a unit test of the pure function gave 100% coverage and zero signal on this.
- **`contracts-check` (T033)**: `@nestjs/swagger` added (already named in 012's plan, no new
  ADR needed); `apps/api/src/openapi.ts` builds the document from `createApiModule`, needing no
  `DATABASE_URL` or any environment variable — contract generation runs the same in CI as on a
  laptop with no `.env`. Generated output is run through Prettier before being written, or it
  would disagree with `format-check` on every regeneration even with zero real drift.
  `apps/api/openapi.json` is the first committed generated artifact.
- **`gate-isolation` (T029)**, **`gate-evidence` (T031)**: both need conventions FR-013/FR-009
  don't specify — a way to say "this test covers that endpoint" and "this model is a
  conclusion type." Invented `assertTenantIsolated(app, method, path)` (a real, greppable
  function call; `test/tenant-isolation.ts`, body unimplemented until 001/002 land auth) and a
  `/// @conclusion` schema doc-comment tag. Both gates pass vacuously today — `/health`/`/ready`
  are hand-exempted as the only non-tenant-scoped paths, and nothing is tagged `@conclusion` yet
  — logged in `QUESTIONS.md` for review before 001 locks either convention in.
- **`gate-undo` (T030)**: reads 010's catalogue location, which doesn't exist yet. Deliberately
  does **not** pass vacuously forever the way the others do — 010 R-02 requires checking a
  test-attestation format 010 hasn't designed, so the gate throws (fails closed) the day any file
  appears in the catalogue directory, rather than rubber-stamping the first entry it sees.
- **`gate-architecture-agnostic` (T032)**: bans customer deployment vocabulary (`monolith`,
  `microservice`, `kubernetes`, `serverless`, `lambda`, …) in `packages/domain/**` and
  `packages/agents/**`, exempting `adapters/`, `discovery/` and `infrastructure/` subdirectories
  per constitution VII. Deliberately does not duplicate the T035 import-boundary lint's job
  (our own stack, e.g. Prisma/BullMQ) — this gate is about the *customer's* architecture leaking
  into the domain model (004 SC-008), a different failure than an import crossing a boundary.
- `make ci` still green: 81 unit tests (coverage-enforced) + 10 e2e tests, ~21s cold-cache.
- Four open questions from this phase recorded in `QUESTIONS.md` for review — mostly "I invented a
  convention 001/010 will need to follow; here's why, tell me if you want it different."

## 0.10.1 — 2026-09-26

**Deep review of 0.10.0 before anything was pushed, then every finding fixed.** The reported green
`make ci` in 0.10.0 was misleading: `scripts/` was untracked, so `secret-scan`'s own
`git ls-files` never saw it. Nothing here was pushed or committed before the review ran.

- **`secret-scan` would have failed on itself.** Its test fixture held a literal private-key
  header; once tracked, the gate it tests would fail on it. Rebuilt from concatenated string
  parts, so the source text never contains the pattern it detects.
- **The gates silently ran nothing on a path containing a space.** The old main-module guard
  (comparing `import.meta.url` against a `file://` string built from `argv[1]`) doesn't hold
  once the path has a percent-encodable character — reproduced. `scripts/lib/harness.mjs` gains
  `isMainModule()`, comparing like with like via `pathToFileURL`; `secret-scan`, `db-check` and
  `db-seed` all use it now. `git ls-files` also gains `-z`, so a non-ASCII tracked path
  (reproduced with a Cyrillic directory) is no longer shell-quoted past `readFileSync` and the
  `.env` pattern.
- **Coverage floors were declared but never checked** — `test-unit` never passed `--coverage`.
  Turning it on immediately caught a real gap: `TenantContext.forTrustedInternalUse` had zero
  test coverage, dropping `packages/shared/src/tenancy` to 93.9%/87.5% against its 95% floor.
  Fixed with a real test, not a lowered threshold. Coverage scope also needed `all: false` and
  a `prisma/generated/**` exclude — without them the global 80% floor measured empty
  future-spec package stubs and the generated Prisma client, at 22%, which said nothing about
  the code under test.
- **`make bootstrap` failed on a fresh clone** — `DATABASE_URL` was never set because nothing
  created `.env`. Added `test -f .env || cp .env.example .env`; ran the full `bootstrap` for
  real (not a dry run) against a fresh compose stack — install, `.env`, migrate, seed all green.
- **T021 was doing less than it claimed.** `db-check`'s previous-release check was a TODO that
  could never fail; the migration e2e test hardcoded one migration's paths and four schema
  names. Rewrote `prisma/migration.e2e.test.ts` to discover every migration under
  `prisma/migrations/` and apply/reverse them in order, to derive the tenant-scoping schema set
  from `pg_namespace` against an explicit global-table allowlist instead of a hand-maintained
  list, and to add a real (if currently vacuous — no release is tagged yet) previous-release
  check via `git ls-tree`/`git show` against the latest `v*` tag. Verified the mechanism
  actually runs by tagging HEAD locally, watching it execute the real path, then deleting the
  tag — never pushed.
- **T075 only looked at whether `down.sql` existed.** A `DROP COLUMN` with a down-script that
  restores the column empty passed with no approval required, because a down-script proves the
  *shape* is reversible, never that the *data* survived. `db-check` now requires approval
  whenever the up-script contains `DROP COLUMN` / `DROP TABLE` / `TRUNCATE`, regardless of
  `down.sql`. The approval file's ADR is now resolved against `docs/adr/` (a citation to a
  nonexistent ADR used to pass) and the owner line must carry a value (`Owner:` alone used to
  pass).
- **`db-check` used to swallow real failures as "no previous release."** A `git` error (not a
  repository, git missing) and zero tags read identically. The two are no longer conflated:
  git failing now fails the gate; the migrations directory being absent now throws instead of
  silently checking zero migrations. Paths use `fileURLToPath`, not `.pathname` (which is
  percent-encoded, not a filesystem path).
- **Tenant integrity of `workflow_transition`.** Its `tenant_id` was a plain column with no
  constraint tying it to its run's tenant — a caller could persist a transition under the wrong
  tenant's run. `workflow_run` gains `@@unique([id, tenantId])`; `workflow_transition`'s FK is
  now composite `(run_id, tenant_id) → workflow_run(id, tenant_id)`, so a mismatched tenant is
  rejected by Postgres rather than merely unindexed. Its two single-purpose indexes collapsed
  into one covering `(tenant_id, run_id, occurred_at)`. `packages/workflow`'s `Transition` type
  gained `tenantId`, set from the owning run in both `start()` and `step()`.
- **Protected paths didn't cover the gates they name.** `scripts/gate*` in
  [make-targets.md](../specs/012-engineering-foundation/contracts/make-targets.md) matches
  none of `secret-scan.mjs`, `db-check.mjs`, `db-seed.mjs` or the shared harness — an
  agent-authored change could have weakened any of them undetected. Broadened to `scripts/**`.
- **Accepted, not fixed**: `secret-scan` still scans only the final tree, not the commits
  introduced by a change set — a key added then deleted within the same PR would still pass.
  Building base-ref diffing now, before any gate establishes what "the change set" means
  relative to a base revision (that lands with `gate-agent-scope`/`gate-red-first` in Phase
  13), would be scaffolding ahead of its own foundation. `db-check` and `test-e2e` both still
  run `prisma/migration.e2e.test.ts` once each within a full `make ci` — a few seconds of
  duplicate container start, kept because hiding the file from `test-e2e`'s glob would make
  `make test-e2e` report zero tests today, which reads as a new bug to the next person who
  runs it.
- `make ci` re-measured at **21.7s** cold-cache (67 unit tests including coverage, 8 e2e tests)
  — recorded in 012's research.md, replacing the pre-fix 32.3s figure from a run where
  `test-unit` was not actually collecting coverage.

## 0.10.0 — 2026-09-26

**012 phase 3 (US1) complete: the gates run on a laptop.** T026, T027 close it out.

- `.github/workflows/ci.yml`: one job, `pnpm install --frozen-lockfile` then `make ci` — no step
  exists only in CI (FR-007). `fetch-depth: 0` so `db-check`'s release-tag lookup sees real tags.
- `make ci` measured cold (`dist/` and every `tsconfig.tsbuildinfo` removed): **32.3s**, against the
  plan's 10-minute budget — recorded in 012's research.md R-09, not left as a one-off terminal
  scrollback fact.
- Phase 3 done: T018–T027, T074, T075. `make bootstrap && make ci` now work from a clean checkout
  with no undocumented manual step, which was this feature's own quickstart success criterion.
- Next per the roadmap: 012 phase 4 (US2 — no endpoint or reversible action ships untested), then
  001 issue-and-evidence.

## 0.9.5 — 2026-09-26

**T019 / T020 `make bootstrap` and `make ci`**, run for the first time and green end to end:
`secret-scan → db-check → format-check → lint → typecheck → build → test-unit → test-e2e`, 59 unit
tests, 7 e2e tests, 16.5s wall-clock (cold-ish; T027 records a real cold-cache number separately).

- `Makefile`: `ci`'s targets run as separate recursive `make` invocations rather than as
  prerequisites, so a failure aborts immediately regardless of `-j` (prerequisite order is not
  guaranteed under parallel make; a single recipe's command lines always are).
- `bootstrap`: install, `docker compose up --wait`, `prisma migrate deploy`, seed.
- `scripts/db-seed.mjs`: one idempotent local-dev tenant, so a fresh checkout has something to
  point the API at — bootstrap's contract says "seed", and seeding nothing would make that a lie.
- Caught by actually running the gate, not by reading it: two pre-existing files failed
  `format-check` the first time — `.specify/feature.json` and three of the new `scripts/*` files.
  `.specify/` (spec-kit's own rewritten state and manifests) added to `.prettierignore`, alongside
  `prisma/generated/` for the same reason; the new files reformatted.
- Removed `package.json`'s `gate` script (`node scripts/gate.mjs`) — the file never existed and the
  real convention, confirmed against T084–T086, is one script per gate under `scripts/gates/`, not
  a generic dispatcher.

## 0.9.4 — 2026-09-26

**T021 / T075 `db-check`**, and two more real gaps the still-unexercised initial migration was
hiding, both caught by actually running it against a live Postgres rather than by re-reading it.

- `prisma/migrations/migration_lock.toml` was missing — `prisma migrate diff --from-migrations`
  cannot even determine the connector without it. Added, provider `postgresql`.
- `prisma/migration.e2e.test.ts` gains two assertions: every tenant-scoped table's `tenant_id`
  leads an index (not just carries the column — a real, closed check on `pg_index`, not name
  matching), and the applied migration diffs to nothing against `schema.prisma` (`prisma migrate
  diff --from-url`). Both watched to fail first: a temporarily reintroduced drift column produced
  exactly the one expected `ALTER TABLE` statement, then was reverted.
- `scripts/db-check.mjs`: `prisma generate`, irreversible-migration approval (a migration with no
  `down.sql` needs a sibling `IRREVERSIBLE.md` naming an ADR and an owner, FR-049), a previous-
  release check that says plainly there is no previous release yet rather than pass silently, then
  delegates applicability/reverse/drift/tenant_id to the one e2e test that owns them.
- `pnpm db-check` now actually runs — the script the command referenced did not exist before this.

## 0.9.3 — 2026-09-26

012 phase 3 (US1) underway, one task per version from here.

- **T074 `secret-scan`**, first target in `ci`: fails on a committed `.env` file or planted private
  key material; `.env.example` and ordinary source are not flagged. Test-first fixtures plant both.
- **T018 / T025 shared gate harness** (`scripts/lib/harness.mjs`): a gate's result has exactly two
  outcomes, pass or fail — there is no third "skip" state for a confused check to reach for. Any
  thrown error becomes a fail (R-10); every gate will report through this one function.
- **Fixed**: `workflow_transition` was missing `tenant_id` and its leading index — a real gap the
  already-written migration e2e test caught the first time it ran against a live Postgres (Docker
  had been down since phase 1–2 landed). Schema, the initial migration and its data model updated;
  all 5 migration e2e assertions and all 48 unit tests green.

## 0.9.0 — 2026-09-26

Specification: 013 planned and broken into tasks; ADR 0010 carried into 008. No code.

- **013 regression-suite** through clarify, plan, tasks and analyze: research R-01..R-09, three tables
  in schema `regression`, a selection contract and OpenAPI document, 20 quickstart scenarios, 38 tasks
  with every requirement and success criterion covered.
- Corrected before it spread: 013's first draft said merging an expectation document is not adoption.
  005 R-16 and C-06 say approval of that pull request **is** adoption, and 013 now follows them — the
  "wiki of scenarios" is 005's repository markdown, reviewed like code.
- Cross-feature additions raised by 013: 005 R-08 front-matter keys (`subject`, `given`, `when`,
  `then`, `priority`); `test_binding_ref` crossing shape; `agent_kind = test_author`.
- 008 R-32 and tasks T127–T130: the change agent, applier, masking analyser and verifier run in the
  runner; the control plane keeps the state machine, guards and tables, which never held patch content.
- C-41 amended: self-hosted Grafana is the planned next step, triggered by an enterprise review or the
  bill, not a rejected option.
- The investigation pipeline page now covers thirteen features, the ADR 0010 seam and 013's seams.

## 0.8.0 — 2026-09-26

Specification: the regression suite (013) and five open questions closed. No code.

- **013 regression-suite** specified: 24 functional requirements, 7 success criteria. A regression
  scenario is an adopted `ExpectedBehavior` — no second store of expected behaviour. Healer drafts
  (API drafts from OpenAPI with no model call), a human adopts, a runner-side test author writes the
  test, a human merges, the customer's CI runs it on every pull request, on a schedule and after
  deploy, and a failure on the default branch becomes a `regression` issue in the one pipeline.
- C-36 no vector index over customer documents in v1 (closes S0-8) · C-37 Healer's repository on
  GitHub · C-38 provider keys rotated by hand through the customer's secret manager · C-39 the
  runner ships with Docker Compose · C-40 merge-rights ruleset read on a schedule for drift ·
  C-41 our own telemetry to Grafana Cloud through one collector, tenant identifiers hashed before export
  · C-42 a GitHub VCS adapter in v1, so Healer runs on its own repository. Constitution 1.2.1.
- ADR 0011: agent-driven development under the same gates. 012 R-13 and R-16 rewritten for GitHub;
  tasks T092–T095 added (ruleset drift, runner-side inference, `agent_run_report`, key rotation).
- Glossary: `ChangePlan` and control plane corrected for ADR 0010; `RegressionTestBinding` added.

## 0.7.0 — 2026-09-26

Specification: **inference follows the source** (ADR 0010, constitution 1.2.0). No code.

- Closed a contradiction at the boundary: the runner contract said file contents never cross, while
  ADR 0006 said source is in the change agent's prompt — and the change agent lived in the control
  plane. No specification described the path between the two.
- A model call now runs where its inputs live. The change agent, 008's masking inspection and the
  verifier execute in the runner against the tenant's provider; the control plane orchestrates through
  `agent_directive` and records `agent_run` from `agent_run_report`. The patch never crosses (C-33).
- A Healer-managed tenant's runner holds a per-tenant, spend-limited, revocable key; no shared key and
  no inference proxy (C-34). Runner-side inference is a declared capability; prompts cross towards the
  runner by identifier and digest (C-35).
- Runner protocol: four new runner-to-control-plane shapes (`change_plan_proposal`,
  `masking_candidate`, `verification_verdict`, `agent_run_report`), two new directives
  (`agent_directive`, `prompt_version`), `change_plan` no longer carries a patch. 008 FR-016a, 012
  FR-046a, 011 FR-004a amended; `agent_run` gains `executed_in` and `runner_instance_id`.
- Security posture: "Healer never processes your source code" is now true, and the runner needs one
  more outbound endpoint — the tenant's model provider.
- Open, stage-0 S0-8: knowledge embeddings in 005 are the same question for documents.

## 0.6.0 — 2026-09-26

Specification: agent-driven development (012 US10). No code.

- A coding agent takes one task to a pull request; only the gates and a human decide whether it lands.
  FR-053..FR-059, SC-020..SC-022, research R-13..R-16, quickstart 36–41, tasks T084–T091.
- **Who is an agent is the VCS host's bot flag**, never commit or pull-request text, and an
  unresolvable identity counts as an agent (R-13).
- Two new gates: `gate-agent-scope` — no protected path, no weakened pre-existing test assertion, a
  task identifier on the pull request — and `gate-red-first` — the change set's tests must fail on the
  base revision. The protected-path list has one authority, [make-targets.md](../specs/012-engineering-foundation/contracts/make-targets.md),
  and protects itself.
- Merge rights, budgets and parallelism are host and provider settings the agent's prompt cannot
  reach (R-16). Their ceiling — settings a local gate cannot read — is stated, not hidden.
- Totals: 373 functional requirements, 141 success criteria, 1 174 tasks.

## 0.5.0 — 2026-09-24

**First code.** 012 phases 1–2 implemented: setup and the foundations every other spec assumes.

- Monorepo: 27 workspace packages over pnpm workspaces with TypeScript project references, so a
  package importing past another's entry surface fails compilation rather than review.
- `packages/shared`: configuration validated once at start and frozen (the only reader of
  `process.env`); Pino logging with `tenantId` and `correlationId` bound and secret- and
  customer-content paths redacted; the closed error-code union; correlation through
  `AsyncLocalStorage`, stamped onto every OpenTelemetry span.
- **Tenancy is a compile-time guarantee**, not a convention: a repository accepts only
  `TenantScoped<W>`, whose brand is unexported, and the sole producer takes a `TenantContext`. An
  unscoped filter is a type error; a `@ts-expect-error` test holds that.
- `packages/events`: the transactional outbox — enqueue takes the transaction, not a store, so
  there is no overload that writes outside one.
- `packages/workflow`: the persisted state machine, the callback registry (tokens stored hashed,
  consumption idempotent, unmatched deliveries recorded), and the seven queue classes with their
  declared wall-clock budgets.
- **A state with nothing to wake it is now undeclarable.** The data model's invariant — a
  non-terminal run has a pending callback or a deadline — was to be checked periodically. A state is
  instead one of three shapes: terminal, awaiting a callback with a timeout, or job-owned with a
  declared wall-clock budget. The compiler proved the fourth shape unreachable while this was being
  written.
- Prisma multi-schema over five schemas with the initial migration **and its reverse**, plus an e2e
  test that applies both against a disposable Postgres and asserts the partial deadline index and the
  ADR 0004 extension list.
- `apps/api` health and readiness as the single source every version check reads; `apps/worker` as
  the same code in a separate process.
- Constitution 1.1.1: the seven queue classes named, as Governance requires of the pull request that
  introduces them.

Verified: `typecheck`, `lint`, `format-check` and 48 unit tests green. Not verified: the compose
stack and the migration were never applied — the Docker daemon was not running — so `test-e2e` has
not been executed. Recorded in 012's tasks.md rather than left implicit.
