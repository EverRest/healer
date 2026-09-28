# Questions for tomorrow morning

Decisions I made autonomously while working through the backlog, flagged here instead of
interrupting. Delete entries once we've talked through them (or I've folded the answer into the
spec docs).

**Decision session 2026-09-27** — all entries below resolved. The binding decisions now live in
[decisions.md](docs/decisions.md) (C-43..C-47); this file keeps only the pointer plus what's still
genuinely undecided, since several other docs point back at this file by name for the reasoning.

## 012 T032, T029, T035, T031, phase 13 — resolved

See [decisions.md](docs/decisions.md) C-43 (`gate-architecture-agnostic` own-stack check), C-44
(`gate-isolation` calling convention), C-45 (T035 stays structural, no ADR), C-46 (`gate-evidence`
`@conclusion` tag), C-47 (Phase 13 T084–T087 start now).

## 012 T037 `deps-check` — the ADR-in-the-same-change-set half

**Deferred, not decided.** Base-revision diffing is the same infrastructure
`gate-agent-scope`/`gate-red-first` need; building a one-off version now would be scaffolding
ahead of the thing that owns it. Waits for Phase 13's diff infra.

## 012 phase 8–10 — secret manager and `packages/llm`

- **T066 (secret manager): deferred**, no ADR yet. Revisit once the tenant deployment/secrets
  story is clearer — not decided today.
- **T067/T068 (`packages/llm` provider adapter): wait** for 010's or a dedicated 012 slice's real
  build (retry, secret resolution, per-tenant config) rather than a throwaway minimal adapter now.

## 001 data-model.md — fingerprint index exclusion set

**Resolved and confirmed**: `where state not in ('merged', 'removed')`, already applied in
`data-model.md`. `resolved` and `stale` issues stay in the fingerprint index (reopen window,
R-11); only `merged` and `removed` drop out.

## Deep review round 2 — migration editing practice

**Resolved, and now a standing rule** (`.claude/rules/prisma-migrations.md`): never edit an
already-committed migration once pushed/shared or once `prisma migrate deploy` has run against a
shared database — a schema change past that point is always a new migration file.

## 001 T006 — `infrastructure/**` excluded from the unit coverage floor

**Resolved and confirmed 2026-09-27**: see [decisions.md](docs/decisions.md) C-49. Kept as-is,
over merging unit+e2e coverage and over a lower (arbitrary) floor.

## 001 T012 — the issue state graph has no `stale -> investigating` edge yet

Not decided, and deliberately not invented ahead of the task that should decide it.
`state-machine.ts`'s graph is exactly what data-model.md's diagram draws: the only reopen edge is
`resolved -> investigating` (matching signal inside the reopen window, FR-005). A `stale` issue
has no edge back to `investigating` at all — only to `resolved`/`merged`/`removed`.

**Update after T018 landed**: T018 did *not* touch this — it deliberately excludes `resolved`
(and `merged`/`removed`) from its fingerprint match, per FR-002's own words ("attach ... to the
same **open** issue"), and creates a fresh issue instead when the only fingerprint match is
resolved. `stale` was left exactly as it was: reachable, but with no edge back to
`investigating`. The question above is now squarely **001 T022**'s (reopen and recurrence) to
answer, not T018's — T018 turned out not to need an opinion on it at all.

## 001 T013 — seven of the eleven contract events have no publisher yet

Not decided, and deliberately not built ahead of the task that owns each one.
`contracts/events.md` names eleven events this feature publishes; T013 wired the outbox for the
four with a real producing operation today: `IssueDetected`/`IssueStateChanged` (001 T012's
`create`/`transition`) and `EvidenceRecorded`/`EvidenceDetached` (001 T006's `record`/`detach`).

The other seven have no operation to hang a publish call off yet, because the operation itself
doesn't exist: `IssueReopened`/`IssueRecurred` (T022, reopen/recurrence — see below), `IssueRelated`
(deterministic correlation, no task number assigned in this phase), `IssueMerged`/`IssueUnmerged`
(T049), `IssueStale` (T051), `IssueResolved` (needs 008/010's verification events to consume, per
events.md's "consumes" table), `IssueDeleted` (T053). Each publisher gets built as part of the
task that builds its producing operation, following the same pattern `events.ts` in
`packages/domain/issues`/`packages/domain/evidence` already establishes — not invented here ahead
of the operation it would describe.

## 001 T018 — three real judgment calls, flagged for review before T019+ builds on them

All three are load-bearing for the ingestion pipeline; happy to reverse any of them.

**1. `Issue.kind` and `severity` defaults for the `/ingest/signals` path.** `Signal` (openapi)
carries no `kind` field, and `Issue.kind` has six values with no spec text saying which one a
provider-pushed signal produces. Chose `monitoring_alert` (a monitoring provider pushed this,
as opposed to `production_incident`'s implied higher-severity manual declaration, or
`automated_detection`'s implied non-provider-triggered discovery). `severity` defaults to
`medium` when the signal omits it (openapi marks it optional). Both are one-line changes in
`ingest-signal.ts` if wrong.

**2. `componentId` stays `null` — 004 (architecture-graph) isn't implemented.** `Signal.component`
is a raw string from the provider; there is no `Component` row to resolve it against yet, so
`issue.component_id` is left unset and the fingerprint hashes the **raw string** instead. Real
consequence: once 004 lands and groups several raw component strings under one canonical
`Component`, today's fingerprints could under- or over-split issues relative to what a
component-aware fingerprint would produce. The fix is exactly what 001 T011 built for this: publish
a new `normalisation_ruleset` version once 004 exists and recompute — not a schema change, a data
change. Flagging now so whoever builds 004's ingestion integration knows to look at this rather
than rediscover it.

**3. `findOpenByFingerprint` + `create`/`recordOccurrence` is a check-then-act, not one atomic
operation.** **Resolved by 001 T026**: this was called "narrow" here, and it was not — a real
load test (`apps/api/load.e2e.test.ts`, real HTTP → BullMQ → worker → Postgres) fragmented a
single burst of a brand-new fingerprint into up to `QUEUE_CLASSES.ingestion.concurrency` (16)
separate issues, exactly the failure this note predicted, just far more likely than "narrow"
suggested. Fixed exactly the way this note proposed: a unique partial index
(`issue_tenant_id_fingerprint_open_key`, migration `20260927060000`, scoped to `state NOT IN
('resolved','merged','removed')` — narrower than T002's existing non-unique index, so a resolved
issue and its later recurrence can still share a fingerprint) plus a new `FingerprintAlreadyOpenError`
`create` throws on the losing side of the race, which `ingestSignal` catches and retries as an
attach to whichever call actually won. Proven at three levels: `issue-repository.e2e.test.ts`
(16 concurrent `create` calls → one issue), `ingest-signal.e2e.test.ts` (same race through
`ingestSignal`, `occurrenceCount` ends at 16), and the real load test (500 signals over the full
HTTP path → exactly one issue, `occurrenceCount` 500).

## Deep review of T011–T018 — 8 findings fixed, 1 test left honestly red rather than faked green

A second independent review of the T011–T018 commits (fingerprint normalisation, the issue state
machine, the outbox's first real backing store) found real bugs, reproduced against a live
Postgres before fixing, same discipline as every prior review round this project has had:

- **`transition()` let two concurrent transitions from the same state both commit** — both
  `detected -> merged` and `detected -> investigating` are legal edges, and a plain guarded
  `UPDATE ... WHERE state = <validated state>` under the default READ COMMITTED isolation still
  measurably let both through. Fixed with `SERIALIZABLE` isolation (Postgres's own conflict
  detection, not hand-rolled lock ordering) plus keeping the state-guarded raw `UPDATE` as a
  second, redundant check — see the residual-flakiness note below.
- **`recordOccurrence` raced itself**: a plain read-compare-write let `lastSeenAt` move
  *backwards* under concurrent signals (9/20 reproduced) and never let `firstSeenAt` move
  *earlier* at all. Fixed with `GREATEST`/`LEAST` inside one atomic `UPDATE`.
- **`create` wrote no `issue_event`** for the signal that created the issue — `occurrenceCount`
  and the timeline's `signal_received` count were always one apart. Fixed: `create` now writes
  the same event `recordOccurrence` writes for every later signal.
- **The outbox's `claimUnpublished` was unlocked and ordered by `occurred_at` alone** — two
  concurrent drain workers could double-publish, and a permanently-failing event blocked every
  event behind it forever (reproduced: 5 failed attempts on the oldest row, the next row never
  tried). Fixed with `claimed_at` + `SELECT ... FOR UPDATE SKIP LOCKED`, ordered `attempts` first.
- **Fingerprint hashing had a real collision**: fields/frames joined with a raw NUL separator
  meant a frame containing a NUL byte was indistinguishable from two separate frames split at it.
  Fixed by hashing structured JSON instead. Also fixed: case-insensitive pattern matching was
  documented but not implemented (missing the `i` flag); R-01 says "top frames", the code hashed
  every frame (now capped at 5, a placeholder pending real tuning, same status as the excerpt
  length limit); patterns were recompiled per field instead of once per signal.
- **A ruleset with an uncompilable regex, or no `stripPatterns` at all, could be published** and
  would only fail the moment `resolveFingerprint` read it back, breaking all ingestion. Fixed with
  a `publishNormalisationRules` validating wrapper — `NormalisationRulesetRepository.publish`
  itself stays generic on purpose (its own e2e test legitimately publishes non-fingerprint shapes
  to prove the repository's opaque-storage contract).
- **`outbox`'s new claim index dropped its required tenant_id-leading index** — caught by the
  migration e2e suite's own leading-index check; restored alongside the new partial index.

**Residual, investigated, not resolved: `issue-repository.e2e.test.ts`'s "two concurrent
transitions" test still fails intermittently in this specific file.** The underlying fix
(SERIALIZABLE isolation + the state-guarded raw `UPDATE`) reproduces as airtight — 0 failures
across 400+ trials — in every clean-room isolation built while investigating this: a standalone
raw-SQL probe, the same probe with the full transaction shape (extra reads/writes), the real
`PrismaIssueRepository` class in a dedicated file, the same wrapped in `withCorrelation`, with and
without an explicit `$connect()`. Only inside this one shared test file does it still fail, at a
rate that varied run to run (roughly 1/15 up to 1/2 depending on exactly which variant was being
tested) — and critically, **retrying within the same process (`{ retry: 4 }`) did not help**: a
failing run failed all 4 attempts together, which rules out a true per-attempt coin-flip race and
points at something set once per process (Docker/testcontainers resource allocation on this
machine was the last untested hypothesis before time ran out). Left as a strict, unretried
assertion — an honest intermittent red is more useful than a retry loop that would hide a real
regression just as effectively as it hides this unresolved one. Whoever picks this up next: start
from "why does retry not help" — that's the fact that rules out the most likely explanations.

**New data point (001 T015 landing)**: this test now fails noticeably more often as part of the
*full* `make ci` (test-unit, `gate-coverage-completeness`, then the whole `test-e2e` suite
including T015's own 12 000-signal replay) than it did running `issue-repository.e2e.test.ts` in
isolation — 3/3 full `make ci` runs failed it, versus roughly 1/2 to 1/15 in isolation depending on
which fix variant was being measured at the time. Consistent with "something about resource
pressure/timing under load," not with a fix that stopped working — T015's own test (25 concurrent
transactions, real load) passed cleanly in every one of those same runs. Raises the priority of the
"testcontainers/Docker resource allocation" hypothesis over the others already ruled out.

**New data point (001 T019 landing)**: a full `make ci` run failed this same test again (this time
`fulfilled.length === 2`, the original symptom). Before assuming T019's changes were the cause
(none of them touch `issue-repository.ts`, `state-machine.ts` or anything else this test exercises
— T019 only adds `/ingest/signals` and its own new files), re-ran the test 3× in isolation on
T019's tree (all 3 failed, two different assertion points — once the `reason instanceof
Concurrent­ModificationError || InvalidIssueTransitionError` check, twice `fulfilled.length`), then
`git stash`ed every T019 change and ran the identical 3× on the unmodified pre-T019 tree: **also
3/3 failed, same two assertion points.** Confirms this is the same pre-existing, unresolved issue,
not a T019 regression, and that on this machine it has moved from "intermittent" toward
"consistently fails in isolation too" — worth escalating priority on whoever picks up the
Docker/testcontainers-resource-allocation hypothesis next, since "isolation used to mostly pass"
is no longer true.

**RESOLVED (2026-09-27, post-T022).** With the failure rate up to roughly 50% in isolation on this
machine, it was finally tight enough to instrument directly: a temporary probe script (real
`PrismaIssueRepository`, real Postgres, 20–60 tight trials, deleted after use) ran the exact
concurrent-transition scenario and printed the *actual* rejection reason on every "unexpected
error type" failure — 20/20 were `PrismaClientKnownRequestError` with Prisma code **`P2010`**
("raw query failed"), `error.meta = { code: '40001', message: 'could not serialize access due to
concurrent update' }`.

**Root cause**: `transition()`'s catch block only checked `error.code === 'P2034'` to translate a
serialization failure into `ConcurrentModificationError`. `P2034` is the code Prisma assigns when
one of *its own generated queries* (`.update()`, `.create()`, …) hits a Postgres 40001/40P01
inside an interactive transaction. The actual conflicting statement in `transition()` is the raw
`$executeRaw` `UPDATE` (needed for the state-guarded `WHERE` clause SERIALIZABLE's conflict
detection keys off) — and Prisma does **not** fold a raw query's serialization failure into P2034;
it surfaces as the generic `P2010` "raw query failed" wrapper, with the real Postgres SQLSTATE
sitting in `error.meta.code` instead. So the exact conflict SERIALIZABLE's whole design exists to
catch was being caught by Postgres, reported by Prisma, and then rethrown as an unhandled
`PrismaClientKnownRequestError` instead of `ConcurrentModificationError` — precisely the "wrong
error type" assertion failure this test had been intermittently hitting all along. This also
explains why every earlier clean-room reproduction *without* the raw `$executeRaw` UPDATE (or
using a plain `.update()` instead) never reproduced it: those paths route through Prisma's own
query engine and correctly get `P2034`.

**Fix**: the catch now also recognizes `P2010` wrapping Postgres `40001` (serialization_failure)
or `40P01` (deadlock_detected) in `error.meta.code`, translating both to
`ConcurrentModificationError` alongside `P2034`. Verified: the instrumented probe went from
20/20 and 0/60 failures before/after the fix; the real test went from ~50% failures to 15/15 clean
fresh-process runs; a full `make ci` run (49 unit files / 262 tests, 15 e2e files / 121 tests) is
now fully green with no retry, no skip and no flake anywhere in the suite. The
"testcontainers/Docker resource allocation" hypothesis, prioritized in the notes above, was a red
herring — the failure rate tracking load was a real correlation (more load, more chances for two
transactions to genuinely overlap and hit the always-broken catch), not the root cause itself.

## 001 T019 — `POST /ingest/signals`: judgment calls

- **Tenant identity is a visible stub, not real auth.** No `ingestBearer` credential verification
  exists yet (001/002 haven't landed auth). Asked the user directly (real security consequence,
  not a routine call): chosen answer was `TenantContext.forTrustedInternalUse` read from a bare
  `X-Tenant-Id` header, with a loud `TODO(001 T019, security)` comment on the controller method —
  an unverified header is a more honest stub than pretending to parse a bearer token would be.
  **Must be replaced before this endpoint is reachable from outside a trusted network.**
- **T019's scope is enqueue-only, not the consumer.** Re-read T024 ("malformed payloads... nothing
  dropped silently") and T025 ("downstream failure retains the signal for retry") — both describe
  *processing-time* outcomes, which only make sense as their own tasks' job. `apps/worker` is
  untouched by this change; `SignalQueue`/`enqueueSignalBatch`/`BullmqSignalQueue` only validate
  and enqueue, never call `ingestSignal`.
- **One BullMQ job per signal, not one job per batch** — so a single malformed signal's own
  retries (`ingestion` queue class, 5 attempts) never retry its unrelated siblings too.
- **Plain `application/commands/enqueue-signal-batch.ts` function, not `@nestjs/cqrs`.** No
  `CommandBus`/`QueryBus` infrastructure exists anywhere in the repo despite
  `.claude/rules/backend-nestjs.md`'s "dispatch to CommandBus/QueryBus" language. Satisfied the
  rule's actual intent (thin controller, logic elsewhere) with a plain function under
  `application/commands/` — matching `plan.md`'s own pre-existing target directory structure for
  `packages/domain/issues` — rather than adopting a new framework-level pattern for one endpoint
  (would need its own ADR, and the precedent from C-45 is "stay structural when a plain answer
  reaches the same guarantee").
- **`zod` for the request DTO, not `class-validator`/`class-transformer`.** `zod` is already an
  approved, ADR-free dependency (`packages/boundary-contract`, `packages/shared`); the other two
  don't exist anywhere in the repo. Picking `zod` needed no new dependency or ADR.
- **Discovered and fixed: `packages/workflow`'s BullMQ wiring (012 T015) never actually worked
  against real Redis.** `bullmq` was added as a dependency but its required Redis client,
  `ioredis`, was not — nothing had ever driven `createQueue`/`createWorker` against a live Redis
  before this task's e2e test (the first consumer of `test/containers.ts`'s `startRedis()`).
  Fixed by adding `ioredis` to `packages/workflow`'s dependencies, to `deps-check`'s allowlist, and
  documenting it in ADR 0003 (bullmq's own `peerDependencies` name it — not an independent
  technology choice this project makes, so no new ADR, just the existing one updated to say so).
- **Discovered and fixed: Express's default 100kb JSON body limit would 413 a legitimate
  near-cap delivery** before the DTO's own `.max(1000)` check ever ran — 1000 signals with
  real `frames` arrays comfortably exceeds 100kb. Fixed with `app.useBodyParser('json', { limit:
  '5mb' })`, applied in both `bootstrap()` and every test that boots the app. The cap that matters
  is still the DTO's; this only stops the transport from silently rejecting valid batches under it.
- **`gate-isolation` didn't fit a write-only, fire-and-forget endpoint.** The existing
  `assertTenantIsolated` helper (`test/tenant-isolation.ts`) encodes "create as tenant A, read as
  tenant B, expect 404" — `/ingest/signals` has nothing to read back, and the helper's body is
  still an intentional stub pending real auth (the same gap this task's own TODO already names).
  Asked the user directly (constitution-level guarantee, genuine design fork, not a routine call):
  chosen answer was a second helper, `assertTenantScopedEnqueue`, proving isolation by embedding a
  unique marker in each tenant's write and asserting the marker only ever resolves back to the
  tenant that wrote it (via the BullMQ job's own `tenantId` field) — real proof, not a presence
  filter that would pass regardless of an actual leak. `gate-isolation`'s detection regex now
  recognizes either helper by name.
- **`/api/v1` URL prefix — was left open here, since decided.** See decisions.md C-52: a global
  `app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] })`, applied consistently in
  `bootstrap()`, OpenAPI generation and every e2e test that boots a real server.
- **e2e test file placement**: `apps/api/ingest.e2e.test.ts` sits beside `src/`, not inside it.
  `apps/api/tsconfig.json`'s `rootDir` is `src`, so a file under `src/` cannot import
  `test/containers.ts` (outside that rootDir) without breaking `tsc --build`. Every other
  Postgres/Redis-backed e2e test already lives outside any tsc project (at the repo root) for the
  same reason; this one needed `apps/api`'s own `@nestjs/*`/`supertest` dependencies too, which a
  true repo-root file can't resolve under pnpm's strict linking — `apps/api/` (sibling to `src/`,
  still outside the tsc project's `include`) is where both constraints are satisfied at once.

### Opus code review, before this shipped: four real bugs found, all fixed and re-verified

Ran `/code-review` (Opus) against the diff before committing. All four findings reproduced first,
then fixed — not patched on faith:

- **`queue.add()`/`addBulk()` against an unreachable Redis hangs forever, never rejects.**
  Reproduced directly: a standalone script calling `BullmqSignalQueue.enqueue` against a closed
  port sat unresolved past 15s. Root cause traced into `bullmq`'s source: `Queue.add`/`addBulk`
  both `await waitUntilReady(client)` before issuing anything, and `waitUntilReady` only resolves
  on the client's `'ready'` or `'end'` event — ioredis's default `retryStrategy` never returns
  `null`, so the client never reaches `'end'` on its own, and the wait is unbounded. Tried
  `enableOfflineQueue: false` first (a plausible-looking fix); reproduced that it does **not**
  help — that setting only affects commands issued after `waitUntilReady` resolves, and this hang
  happens before that. The actual fix: `BullmqSignalQueue.enqueueBatch` wraps its own `addBulk`
  call in an explicit 3s `Promise.race` timeout, throwing `SignalQueueUnavailableError`, which the
  controller catches and turns into `503`. Kept `enableOfflineQueue: false` anyway, for a
  different, real reason: without it, a command started during an outage can still fire *later*
  once the connection recovers, after the caller has already been told it failed and moved on. A
  new e2e test boots a second app instance against a closed port and asserts `503` inside 10s
  (measured 3.0s, matching the budget) — this is the test that would have caught the original bug.
- **Batch enqueue wasn't one atomic unit.** `enqueueSignalBatch` called `SignalQueue.enqueue` once
  per signal via `Promise.all` — N separate round trips. A failure partway through leaves some
  signals enqueued while the caller sees the whole request as failed; with no `X-Delivery-Id`
  idempotency until T020/T021, a naive client retry then double-enqueues the part that had already
  landed. Changed the port from `enqueue(signal)` to `enqueueBatch(signals)`, implemented with
  BullMQ's `addBulk` — one pipelined round trip. (Verified `addBulk` uses `client.pipeline()`, not
  a `MULTI`/`EXEC` transaction — a per-job script error still only fails that one job, which is a
  reasonable, not a false, guarantee: it matches this repo's own "nothing dropped silently, create
  what parsed" philosophy rather than promising strict all-or-nothing.)
- **Two zod validation choices would have dropped legitimate events, against FR-019.**
  `z.string().datetime()` rejects a valid RFC 3339 timestamp carrying a timezone offset
  (`+02:00`), accepting only a literal `Z` — confirmed with a standalone zod script.
  `.strict()` on the signal and error-signature schemas meant a provider adding one new field to
  its payload would 400 every future delivery. Fixed: `.datetime({ offset: true })`, and `.strict()`
  removed from the two inner schemas (kept on the outer `{ signals: [...] }` wrapper, which is
  fully under this endpoint's own control). Added e2e tests for both: an offset timestamp and an
  unrecognized field, both now 202.
- **`assertTenantScopedEnqueue`'s first version never touched its own `app`/`method`/`path`
  arguments.** It only called a caller-supplied `writeAs`, which could point at anything —
  `gate-isolation` recognizing the call proved nothing about what code path actually ran. Rewrote
  the helper to perform the HTTP request itself against the three arguments it's given
  (`tenantHeader`, `bodyFor(marker)`, `expectStatus`), so naming the endpoint and exercising it are
  now the same call.
- **Two smaller findings, also fixed:** the DTO's `.max(1000)` and `enqueueSignalBatch`'s
  `MAX_SIGNAL_BATCH_SIZE` were two independent copies of the same number — the DTO now imports the
  constant, so `SignalBatchTooLargeError` is actually reachable from this endpoint instead of
  permanently dead code sitting behind the DTO's own (previously separate) cap. And every signal
  in a batch was getting its own random correlation id instead of sharing one per delivery — the
  controller now wraps the whole handler in `withCorrelation(newCorrelationId(), ...)`; a new e2e
  test asserts every job from one batch carries the same id.

Re-ran the full suite after all five fixes: 48 unit files / 257 tests, 14 e2e files / 103 tests
(9 in `ingest.e2e.test.ts`, up from 5), all `make ci` gates pass. The one remaining e2e failure is
the pre-existing, already-documented `issue-repository.e2e.test.ts` flake above — unrelated to any
of this (re-confirmed via `git stash`: fails identically on the pre-T019 tree).

## 001 T020/T021 — `X-Delivery-Id` idempotency: judgment calls

- **`X-Provider-Id` is a second stub header, same pattern as `X-Tenant-Id`.** The idempotency key
  is `(tenant, provider, deliveryId)` (data-model.md), but nothing in the contract or the
  `Signal` schema names a provider — `ingestBearer` is described only as "provider ingestion
  credential, tenant-scoped", implying a real implementation would derive it from that credential.
  Since T019 already established the pattern of a bare, TODO-flagged header standing in for a
  missing auth claim, extending it to a second header is the consistent, mechanical choice here —
  not a new fork, so not escalated to `AskUserQuestion`.
- **Enqueue happens before recording the delivery, not after.** The alternative (claim the
  delivery id first, then enqueue) would be race-safer for the rare concurrent-duplicate case, but
  its failure mode is worse: a process death between the claim and the enqueue leaves a delivery
  marked `accepted` with nothing ever actually enqueued — a silently lost batch, which FR-019
  ("must not lose events") rules out outright. Enqueue-then-record's own failure mode is milder: a
  genuinely concurrent identical delivery can pass the duplicate check twice and enqueue twice,
  with only one delivery row winning the unique-constraint race — a narrow, accepted race, the
  same precedent as the fingerprint's own documented first-arrival race. The common real-world
  case (a provider's at-least-once redelivery after a timeout) is sequential, not concurrent, so
  this ordering handles the case T020 actually describes correctly and loses no events.
- **`DuplicateDeliveryError` lives in the domain module, not the infrastructure one.** First draft
  defined it in `PrismaIngestionDeliveryRepository`'s file and had the application-layer
  `ingestSignalBatch` import it from there — caught before it typechecked as a layering violation
  (`backend-nestjs.md`: "domain and application depend on repository interfaces", not concrete
  infrastructure classes). Moved the error to `domain/ingestion-delivery.ts`, alongside the
  `IngestionDeliveryRepository` port it belongs to; the Prisma implementation now translates its
  own P2002 into that shared, port-level type.
- **`apps/api` needed its first `infrastructure/` folder.** Constructing a `PrismaClient` in
  `main.ts` directly tripped the repo-wide lint rule confining `@healer/prisma-client` to
  `infrastructure/**` and `prisma/**` — added `apps/api/src/infrastructure/prisma.ts` with a
  one-function `createPrismaClient(url)` wrapper so `main.ts` never imports the package directly.
- Re-ran the full suite after T020/T021: 49 unit files / 262 tests, 15 e2e files / 113 tests
  (`ingest.e2e.test.ts` grew from 9 to 13; new `ingestion-delivery-repository.e2e.test.ts`, 6/6),
  all `make ci` gates pass. The one remaining e2e failure is the same pre-existing, already
  documented `issue-repository.e2e.test.ts` flake — unrelated.

## 001 T022 — reopen and recurrence: judgment calls

- **Reopen window = 14 days, a placeholder, not a measured value.** `docs/stage-0.md` S0-7 names
  "reopen window" explicitly as one of the numbers this spec deliberately left unset pending S0-1
  incident-cadence data. 14 days is a common default for alerting/monitoring tools, documented as
  a placeholder in `ingest-signal.ts` next to the constant, same status as `MAX_FINGERPRINT_FRAMES`
  (T016) and the excerpt-length limit — belongs behind per-tenant configuration once that exists
  (R-02: "the window is per-tenant configuration"), not hardcoded, but there is no tenant-config
  store yet to put it behind.
- **`resolved_at` is a new denormalized column on `issue`, not derived from `issue_event`.** The
  spec's acceptance scenarios measure the window from *when the issue was resolved*
  ("after the issue was resolved" / "long after resolution"), not from `last_seen_at` — a resolved
  issue can sit quiet for weeks before anyone closes it. That timestamp is technically recoverable
  from `issue_event` (the most recent `state_changed` row with `to_state = 'resolved'`), but
  recomputing it via a second query on every signal that misses `findOpenByFingerprint` costs a
  join per ingestion for what is otherwise the common case. `resolved_at` is the same
  denormalized-status-timestamp shape `stale_at` already uses on this same table — set by
  `transition()` the moment `state` becomes `resolved`, cleared the moment it leaves. New migration
  `20260927050000_issue_reopen_recurrence` (reversible, `db-check`/migration e2e both pass).
- **The window compares against the signal's own `observedAt`, and a negative difference routes
  to recurrence, not reopen.** R-10's source-clock principle says ordering decisions use when the
  failure actually happened, not when it arrived — a delayed delivery should still be judged
  against the real gap. A signal whose `observedAt` predates the issue's `resolvedAt` (severe
  out-of-order delivery, or a test fixture with a fixed historical timestamp reused across a real
  wall-clock resolve) is **not** treated as "inside the window" just because the arithmetic
  difference is negative — that would have made ordinary test fixtures spuriously reopen. This
  routes such a signal into the recurrence branch instead of reopening the still-relevant issue,
  a real, unexercised edge case flagged in `ingest-signal.ts`'s own comment rather than hidden.
- **`create()` grew a `recurrenceOf` field**, writing the `recurrence_of` `issue_relationship` row
  and a `related`-type `issue_event` in the same transaction as the new issue — an issue created
  as a recurrence with no relationship row would be exactly the "prose guarantee, no mechanism"
  shape `docs/patterns.md` argues against. The rule name (`reopen_window_exceeded`) is hardcoded
  inside `create()`, not a caller-supplied parameter: this path only ever creates a recurrence for
  one reason, so `create()` is the one authority for how it explains itself. `related` is the
  closest existing `issue_event.type` for "an issue-to-issue relationship was recorded" — the
  closed list has no dedicated `recurrence` value, and adding one is a bigger, closed-list-owner
  decision than this task's diff, not something to invent in passing.
- **Reopen transitions before attaching the signal (`transition` then `recordOccurrence`), not the
  reverse.** Both are independently safe to call in either order (neither checks the other's
  effect), so this is a readability choice, not a correctness one — "the issue reopens, then the
  signal that reopened it is recorded" matches how the acceptance scenario reads. A crash between
  the two leaves the issue correctly reopened with a slightly stale count, corrected by the next
  occurrence.
- Re-ran the full suite after T022: 49 unit files / 262 tests, 15 e2e files / 120 tests (10 new in
  `issue-repository.e2e.test.ts`: `resolvedAt` set/clear, four `findMostRecentlyResolvedByFingerprint`
  cases, `create`-with-`recurrenceOf`; `ingest-signal.e2e.test.ts` gained a real reopen test and
  replaced its old T018 placeholder with a recurrence test that checks the relationship row), all
  `make ci` gates pass. The one remaining e2e failure is the same pre-existing, already documented
  `issue-repository.e2e.test.ts` concurrency flake — unrelated (it now also passed cleanly in one
  of the runs during this task, consistent with its documented intermittency).

## 001 T024 — where does a totally-unidentifiable parse failure's "evidence" attach?

Not decided, genuinely open, flagged rather than guessed at.

Quickstart 20 says a malformed signal's parse failure should be "recorded as evidence", but
`evidence.issue_id` is `NOT NULL` — evidence cannot exist without an issue. A signal missing a
required top-level field (`observedAt`/`component`/`environment`/`errorSignature`) has no
fingerprint, no component, no environment: nothing to create or attach an issue to. Today's
build (T024) satisfies "nothing dropped silently" a different way — naming the rejected signal
and why in the `POST /ingest/signals` response's new `rejected` array — rather than inventing
either of:

- a placeholder/junk-drawer issue per tenant that every unparseable signal attaches to (a real
  new concept nothing else in the spec names), or
- a new `Evidence.type` value for "this couldn't be parsed" attached to... which issue, still
  unresolved, so this doesn't actually close the gap above.

If a reviewer wants the literal "evidence" behavior, the first step is deciding which of the two
(or a third option) it should be — that's a data-model-shaped decision, not a one-line fix.

## 001 T025 — a narrow correctness bug BullMQ's own serialization surfaced

**Resolved and fixed**, recorded here because it was a real, silent-failure-shaped bug, not a
style note: `apps/worker`'s dispatch loop originally returned `processSignalJob`'s full
`IngestSignalResult` (carrying the created/attached `Issue`, which has `occurrenceCount: bigint`)
as the BullMQ job's return value. BullMQ `JSON.stringify`s whatever a handler returns to store as
`job.returnvalue`, and `JSON.stringify` throws on a `bigint` — so a signal that *successfully*
created or attached to an issue was reported to BullMQ as a **failed** job, which then retried,
which would have attached the same signal a second time and inflated `occurrenceCount` on every
subsequent retry. Fixed by returning a small JSON-safe `{issueId, created}` summary from the
dispatch loop instead of the domain result — `apps/worker/worker.e2e.test.ts` explicitly waits
past where the retry would have landed and asserts the job reached `completed`, which is what
would have caught this before it shipped.

**General lesson, not specific to this bug**: any queue handler in this codebase that returns a
domain object containing a `bigint` field (any `occurrenceCount`-shaped value, currently only on
`Issue`) will hit the identical failure mode. Nothing enforces "job handlers return JSON-safe
values" mechanically today — worth a lint rule or a typed `JobResult` boundary if a second handler
ever needs to return something richer than `undefined`/`{issueId, created}`-shaped data, flagged
here rather than built speculatively for a problem with exactly one occurrence so far.

## 001 T026 — "the design signal rate" and "the plan's latency budget" don't exist

Not decided, genuinely open — a real spec gap, not a value this task could read off anywhere.

SC-006 says ingestion must sustain "the design signal rate" with latency "under the target
defined in the plan." Grepped `plan.md`, `spec.md`, `research.md` and `docs/stage-0.md`: no such
rate or budget is defined anywhere, and it isn't in S0-7's own tracked list of deliberately-unset
numbers (001's row there names only the reopen/stale windows and the excerpt limit — this one was
missed entirely, not merely deferred).

Applied S0-7's own rule for a number nobody measured yet rather than blocking on it:
`apps/api/load.e2e.test.ts` documents `TARGET_SIGNALS_PER_SECOND = 100` and
`LATENCY_BUDGET_MS = 5_000` as named, reasoned-about placeholders — a starting value chosen to
fail closed, same status as the reopen window (001 T022) and `MAX_FINGERPRINT_FRAMES` (T016).
Measured on this machine: ~90-100/s sustained through the real HTTP → BullMQ → worker → Postgres
path, fully visible well inside the 5s budget, once the T026 race fix (above) was in place —
before that fix, the same load did not even reliably finish inside 60s, because it was creating
up to 16 issues instead of one and none of them ever reached the target count alone.

Whoever adds "ingestion signal rate" and "ingestion latency budget" to S0-1's real, measured list
should update these two constants to match, and update `docs/stage-0.md` S0-7's table to actually
carry this row.

## 001 T027–T031 — resolved

See [decisions.md](docs/decisions.md) C-53 (`assertTenantIsolated` implemented for real), C-54
(`gate-isolation`'s literal-placeholder path convention), C-55 (`findById` treats a malformed id
as absent, not a 500).

## 001 T033–T035 — resolved

See [decisions.md](docs/decisions.md) C-56 (`check:*` scripts talk to a live database directly,
no ADR — matches `db-seed.mjs`'s existing precedent), C-57 (`check:evidence-coverage` correctly
checks zero tables today), C-58 (every check's live query proven against a real Postgres).

## 001 T037–T040 — resolved

See [decisions.md](docs/decisions.md) C-59 (`knowledge_drift` may still be human-resolved), C-60
(deterministic correlation built but not yet wired into `ingestSignal` — real call site named for
whoever lands 004), C-61 (`GET /issues` does N+1 relationship fetches, accepted until profiled),
C-62 (`assertTenantIsolatedList`, a third isolation helper for list endpoints).

## 001 T041 — resolved

See [decisions.md](docs/decisions.md) C-63: closed with no new test file — `gate-isolation`
already is the continuously-enforced matrix for every endpoint that exists; timeline/audit don't
exist yet. **Phase 5 (US3) is now complete.**

## Deployment, release automation and smoke/regression testing of our own environment — not recorded anywhere until now

Not decided, genuinely open — asked directly ("чи зафіксовано десь"), checked, and it was not.

`.github/workflows/ci.yml` runs `make ci` on push/PR — that is the only workflow in this
repository. 012 FR-052 is the only thing any spec says about the v1 control-plane deployment, and
it is a negative constraint ("must not require Kubernetes or Terraform"), not a positive target.
Nothing specifies:

- a release workflow taking a merged commit to a running staging/production environment;
- an automated post-deploy smoke check;
- an automated regression suite (Playwright or otherwise) exercising a *running* Healer
  deployment end to end — Playwright's one use in this codebase is the **product's** client-side
  reproduction capability (007/008, C-24..C-28), a different thing entirely from a check against
  our own environments;
- a rollback path when a deploy fails its own smoke check (010's safe-remediation story is about
  a *customer's* infrastructure, not ours).

Recorded in [research/wiki/operating-healer.md](research/wiki/operating-healer.md)'s new
"Getting there" section rather than left only here. Not fixed here on purpose: picking a hosting
target, a release tool and a smoke-check design is new-infrastructure/new-dependency territory —
this repo's own rule sends that to an ADR first, not a silent choice made while working through
an unrelated task list. Whoever picks this up next should decide the hosting target before
anything else; the release workflow and smoke checks follow from that choice, not the reverse.

## 001 T046 — which `cause` does a timeline entry carry when its table has none?

`TimelineEntry.cause` follows the contract's set (`ingestion | agent | human | policy | system`).
`workflow_transition.cause` is `job | callback | timeout | human | policy` and `evidence` has no
cause column, so: `human`/`policy` pass through, everything else — the three machine causes and
every evidence row — reads as `system`, with the producing step as `actorRef` for evidence.
Chosen because a step's name does not say whether an agent or plain code ran it, and calling
evidence `agent` would be a claim nothing recorded. Revisit if the audit trail (T042) ends up
carrying a real actor type per step; then the timeline can read it from there instead.

## 001 T042 — `AuditRepository.record` has no real caller yet

Not decided, genuinely open — a real, named dependency block, not a corner cut.

FR-012 requires `action` to be a registered `policy_action.action_key` (002), and requires "every
agent action and every policy decision" to get an entry. 002 (the policy engine and its action-key
registry) does not exist anywhere in this repo, and no agent execution path exists either (012
never built a caller for `agent_run`, only the schema — confirmed via `prisma/agent-run-single-
store.test.ts`, which only proves the table stays the single store, not that anything writes to
it). Inventing action-key strings now would be guessing at a closed list this feature does not
own — the same reasoning behind not inventing 002's own values anywhere else in 001.

Built and proven anyway (`AuditRepository`, `audit-repository.e2e.test.ts`, T042/T043): the write
mechanism, the append-only guarantee (already covered by `append-only.e2e.test.ts` since T004),
and the SC-007 `agent_run` resolution. `GET /issues/{id}/audit` (T044) is real and correctly
returns nothing today, since nothing has ever called `record`. Whoever builds 002 or a real agent
execution path is the one who wires a real call into `transition`/`create`/wherever the first
real action lives — not this task, and not guessed at here.

## Review of T027–T044 — resolved

See [decisions.md](docs/decisions.md) C-67 through C-71: the vacuous HTTP isolation tests (fixed,
verified by deliberately breaking tenant scoping and watching the tests go red), directional
correlate idempotency, `findOpenCorrelationCandidates` including resolved issues,
`check:evidence-coverage`'s tenant-scoping and fail-closed gaps, and `NewAuditEntry`'s discriminated
union. Two findings considered and deliberately not fixed, also recorded there (a DB CHECK
constraint the type-level fix already supersedes; logging for a currently-unreachable branch).

## 001 T051 — staleness sweep: what "progress" is, and three things it leaves open

**Decided.** Progress is the *system's* clock: the latest `issue_event.received_at` for the issue,
or `created_at` if it has none. Not `last_seen_at`: that is the source clock (R-10) and never moves
backwards, so a delayed signal from last month would leave it untouched — yet it is a signal that
just arrived, and the issue it landed on is not idle. State changes count as progress too, so an
issue being worked on with no new occurrences is not swept. The window is 30 days
(`STALE_WINDOW_MS`), a placeholder in the same way `REOPEN_WINDOW_MS` is — S0-7 lists it as unset.

**Open — nothing schedules the sweep.** `staleness-sweep` (queue `maintenance`, data
`{ tenantId }`) is routed in `apps/worker` and tested, but no code enqueues it: that needs
something to enumerate tenants and a repeatable schedule, which is 012's scheduling territory and
a new pattern (ADR first). Until then the sweep is correct and consumed by nothing — the
"guarantee with no reader" shape AGENTS.md names. Whoever picks up scheduling should also decide
whether the window becomes per-tenant configuration.

**Open — a signal arriving on a `stale` issue.** `data-model.md`'s state diagram has no edge out of
`stale` except resolve/merge/remove, and `findOpenByFingerprint` counts `stale` as open. So today a
matching signal attaches to the stale issue (count goes up) and the issue stays `stale` forever:
the dashboard keeps saying "nothing is happening" about something that is. Options: a
`stale -> investigating` edge on a new signal (the reopen path, without a window), or exclude
`stale` from "open" so the signal starts a new issue. Not chosen here — it changes the state graph
and the fingerprint rules both.

**Resolved by review — the race with a signal that is mid-commit.** The first version of `markStale`
re-measured progress at READ COMMITTED and then ran an `UPDATE` guarded only by `state`. A
`recordOccurrence` that had locked the row but not yet committed was invisible to that check; the
`UPDATE` waited on the lock, re-tested only `state`, and marked a live issue stale over a committed
signal — a window as wide as the other transaction, not "microseconds" as this note first said.
`markStale` now takes `SELECT … FOR UPDATE` first and reads and measures afterwards, which works
because `recordOccurrence` and `transition` both take that row lock before writing their event. The
test that proves it holds a transaction open exactly as `recordOccurrence` does. **Still relies on
that lock order:** a future writer of `issue_event` that inserts the event without touching the
`issue` row first would not be waited on.

**Progress is `issue_event.received_at` only.** Evidence recorded and audit entries written do not
count, so a long investigation that changes no state and receives no signals can be swept. That
follows the spec's wording ("no signals and no progress") read as issue-level facts; if an
investigation that is still collecting evidence should keep an issue alive, that needs its own
decision. `correlate` writes its event for one side of the pair only, so the other issue gets no
progress from being linked.

**Not addressed — unknown job names.** `apps/worker/src/main.ts` ends with `return undefined`, so a
misspelled `staleness-sweep` from a future scheduler would complete as a successful no-op. That is
how every route in that dispatcher already behaves, not something T051 introduced; changing it
touches all queues and is left for whoever wires the scheduler.

## 001 T052 — evidence retention: what "expired" does to evidence a conclusion cites

**Decided.** T052 reads "purging expired evidence and detaching what outlives its source". The two
requirements pull apart for cited evidence: R-04 and FR-009 say a conclusion must keep its support,
and `evidence_link` has a `Restrict` foreign key to `evidence` besides. So, per tenant, oldest expiry
first, at most 500 a run:

- expired and **nothing cites it** -> deleted, through the `healer.privileged_write` bypass, with
  the `audit_entry` written in the same transaction (id and fact only, never the excerpt);
- expired and **a conclusion cites it** -> only detached (`linked -> detached`); the row, excerpt and
  `source_label` stay;
- cited and already detached -> finished, not listed again, so a second run converges.

The "nothing cites it" test is inside the `DELETE`'s own `WHERE`, not a read before it; the foreign
key is the second wall, and the only one that answers when a link is *uncommitted* at the moment of
the delete (a test holds exactly that open; it fails if the error mapping is removed). The two
walls are not separately testable — with the `NOT EXISTS` gone the FK still refuses — so that
predicate is defence in depth, not something a test pins on its own.

The bypass goes through `withPrivilegedWrite` (`@healer/prisma-client`), which opens the
transaction itself and issues `set_config(..., true)` — the migration asked for exactly one such
helper, and T053 (tenant deletion) must use it too, not a second copy. A test on a
`connection_limit=1` client proves a plain `DELETE` on the very same connection is still refused
afterwards, and fails if the setting is made session-level. **The bypass covers every statement in
its transaction**, not only the delete: the triggers accept any UPDATE, DELETE or TRUNCATE on any
append-only table while it is on. Keep the callback to the destructive statement and its audit write.

`detach` is now idempotent (it only updates a `linked` row), because two overlapping runs — the
`maintenance` queue runs two at a time, with retries — each listed the same cited record and each
published `EvidenceDetached`. A second call is a no-op that returns the row.

**Open — cited evidence keeps its excerpt forever.** Detached is not purged. `data-model.md`'s
diagram ends `detached --expires_at--> purged`, which cannot happen for a record a link still
names, and `evidence` rows cannot be updated to blank the excerpt. If "retention" is meant to bound
how long customer text is held even when a conclusion cites it, that needs a privileged excerpt scrub
(the row and label stay, the text goes) — a decision about what FR-009's "support" requires the
text to be. Not chosen here.

**Open — "outlives its source" is read as `expires_at` only.** Nothing asks the source system
whether the log line or branch is still there; that needs a runner call (003) and belongs to whatever
notices the source is gone. `DetachEvidence` already exists for that caller.

**Open — the audit action is unregistered.** `evidence.retention_purge` is not a
`policy_action.action_key`: 002's closed list does not exist yet, the gap `NewAuditEntry` already
documents. One line to change in `prisma-evidence-retention-repository.ts` when it does.

**Open — nothing schedules it**, for the same reason as the staleness sweep: no tenant enumerator and
no repeatable schedule. The batch cap means a large backlog needs several runs to clear.


## 001 T057/T054/T055/T048 — human close, IssueResolved, and the timeline/graph routes

**Decided — who is the actor on a close.** The auth layer provides no user identity:
`TenantContext` carries a tenant id only, and every route resolves it from an unverified
`X-Tenant-Id` header (the T019 stub, no `tenantBearer` is verified anywhere). Options were a fixed
`actor_ref` such as `human` (honest but useless for "who closed this"), a fabricated user (no), or a
caller-asserted header. Chose **`X-Actor-Id`, required, 1-128 chars**, stored as `actor_ref` on the
`human`-cause `issue_event`: same trust level as `X-Tenant-Id`, so it adds no new hole, and a close
cannot be recorded with nobody behind it. It is a claim, not an authenticated fact; when real auth
lands it is replaced by the token subject and the header goes away. Not in the spec's
`contracts/openapi.yaml` (which assumes the bearer carries it) — left as is.

**Decided — `Idempotency-Key` is validated, not stored.** No idempotency-key table exists, and
adding one is a new pattern (ADR first). Closing is naturally idempotent by state instead: closing an
`resolved` issue, a repeat with the same or a new key, and a lost race against another close are all
`200` with nothing written and one `IssueResolved`. Consequences, none silent in the code but all
gaps against the contract's wording: (a) the contract's "same key, different body is 409" is **not
implemented** — a second close with another `reason` is a 200 and its reason is discarded; the
original actor and reason stay on the original event; (b) the key is only checked to be a UUID.
`merged`/`removed` issues answer `409`.

**Decided — `resolved` is reachable only with cause `human`.** `checkResolutionCause` in the state
machine refuses `ingestion`/`agent`/`policy`/`system` into `resolved` for every kind. `fixed` is
reserved (C-09, 008 R-25) and `remediated` needs 010's `RemediationVerified`; neither exists, so an
automated resolution today would be one nobody verified. Refused rather than labelled. Two
`state-machine.test.ts` cases that resolved with cause `agent` were changed deliberately. **When 010
lands** it needs its own entry point that carries the verification evidence ids and builds
`{ kind: 'remediated', verifiedAt, verificationEvidenceIds }` — do not widen the cause list.
`IssueResolution`'s `remediated`/`fixed` variant exists in `events.ts` and is exercised only by its
unit test (nothing constructs one in production): kept because the task asked for the shapes to be
unrepresentable, not because a caller needs it yet.

**Decided — `IssueResolved` comes from `transition()`, once per resolution.** A close after a reopen
publishes a second `IssueResolved` (a distinct event, distinct id); consumers are idempotent by
`(eventId, consumer)`. `knowledge_drift` issues can be closed by a human (C-59). The unit scan test
(`issue-resolved.test.ts`) pins the producer to one builder and one call site; a future emitter has
to update it on purpose.

**Decided — the close `reason` is stored on the `state_changed` event's payload** (`{ reason }`),
via a new optional `reason` argument on `transition`, bounded at 1000 characters (a placeholder, like
the other windows) and NUL-free (Postgres `jsonb` cannot store NUL). Free operator text in an
append-only table is data, never instructions, like everything else retrieved.

**Decided — what "the same facts" means (T048/quickstart 16)** is written out in the test's comment
and asserted against the tables, not between views. Not covered: the timeline does not include audit
entries or evidence links (they are other views of the same records, not timeline rows), so the
audit leg checks that every cited evidence id is one of the issue's evidence and visible in both
other views.

**Open — the audit leg is fixture-only.** No production caller writes `audit_entry` yet (T042), and
`audit_entry.evidence_ids` is an array with no foreign key, so nothing refuses an entry that cites
another issue's (or another tenant's) evidence id. The consistency test would catch it on its
fixture; it cannot catch it in production. A real caller (002 or the first agent action) should
validate the ids at write time.

**Open / not done.** `VERSION`/`docs/changelog.md` not bumped (parallel branches would conflict on
it). The `QUESTIONS.md` "001 T052" section named in the task brief does not exist in this branch's
history. `createApiModule` now takes eight positional dependencies; a module-level options object
would stop that growing, but changing it touches every e2e file and the parallel merge/unmerge
branch. T056 (whole quickstart) not run. The generated `openapi.json` declares `X-Tenant-Id`,
`X-Actor-Id` and `Idempotency-Key` as required header parameters (Nest infers them from `@Headers`)
and the `Idempotent-Replay` response header (one `@ApiOkResponse` — the first swagger decorator in
`apps/api`, from an already-installed dependency). What it omits: the close request body (`reason`,
required, 1-1000 characters), the 400/404/409 responses as entries of their own, the UUID format of
the key, and the fact that the key is only validated, never stored.

### Review of 72c4fc6 — what changed, and what was recorded rather than built

**Fixed — a no-op close is observable.** `closeIssue` returns `closed`; the route sets
`Idempotent-Replay: true` when it is false, so a second closer is not left believing its actor and
reason were recorded (they were not; the original stands). A header rather than a body field so the
`Issue` schema is unchanged.

**Fixed — a real close writes an audit entry (FR-012).** `transition` takes an optional `audit`
(`{ action }`), and writes the `audit_entry` in the same transaction as the state change, the
`issue_event` and both outbox rows (`prisma-transition-effects.ts`; same `tx.auditEntry.create`
shape `PrismaAuditRepository.record` uses — no new pattern). Human-caused transitions only, and a
reason is required with it; both refused before any write. Proven by a rollback test that makes the
last write of the transaction (the `IssueResolved` outbox insert) fail with a database trigger and
finds the state, event, audit entry and outbox rows all rolled back. The action is `issue.close`,
**not a registered `policy_action.action_key`** — 002's list does not exist, the same known gap as
every other audit action in this feature (T042). Still missing audit writers: nothing else that
mutates through the API exists yet, so close is the only one.

**Fixed — publish site checks the cause.** `resolutionForCause` (events.ts) is the publish site's
own statement of the rule; `planTransitionEffects` calls it before the first write. A unit test asserts
that, for every cause, the publish site has a resolution exactly when the state machine lets that
cause reach `resolved`: widening one without the other fails it.

**Fixed — a busy signal stream no longer turns a close into a 409.** `closeIssue` retries a
`ConcurrentModificationError` up to 3 attempts, only when a re-read shows the state it started
from; a different state, a graph refusal (`merged`/`removed`), or attempts exhausted surface as 409.
Known limit: a resolve followed by a signal-driven reopen entirely inside one race window leaves the
state equal to where it started, so the retry closes the reopened issue. That needs a version
column to detect; not built. The asked-for "signal reopens mid-close, expect 409" test is therefore
not written as such: a reopen only exists from `resolved`, where a close is already a no-op.

**Fixed — one authority for "only a human may resolve".** `checkKnowledgeDriftGuard` lost its
`resolved` clause; `checkResolutionCause` covers every kind. C-59's resolved clause (`knowledge_drift`
may be auto-resolved never, human may) is now generalised by the cause rule — the kind-specific
guard only keeps `acting`. The `knowledge_drift` assertions in `state-machine.test.ts` and
`issue-repository.e2e.test.ts` were changed to the new message deliberately.

**Test changes.** T048 now compares graph edges to the `(evidence, conclusion, relation)` tuples of
the `evidence_link` rows, asserts the audit entry's evidence ids equal exactly the two it cited, and
seeds two other issues in the same tenant (evidence, links, machine steps, audit) so a lost
`issue_id` filter fails (each of the three timeline arms, the graph and the audit read was broken
on purpose and fails). Byte-identical output is asserted across separate requests for timeline
and graph: it proves the same stored records render the same bytes; it does not prove the order is
the right one (`timeline.e2e.test.ts` does) or stability under concurrent writes. The concurrent
triple-close HTTP test now only claims "exactly one real close"; the lost-race branch is entered
deterministically by held-open-transaction tests that poll `pg_stat_activity` for a lock wait
instead of sleeping. The producer scan now strips comments, matches the bare word (any quoting or
template), rejects aliasing/re-export of the builder and any outbox write outside the outbox store,
and covers `.ts/.mts/.js/.mjs/.sql` under `apps packages scripts test prisma`; nine disguised
second producers were added one at a time and each failed it. The "fails validation" test was
renamed to what it proves; atomicity has its own rollback test.

**Recorded, not built.**
- Unexpected 500s from any route are invisible: both `NestFactory.create` calls use
  `logger: false` and there is no exception filter. Pre-existing; close is only the first mutation.
- The close `reason` is stored in `issue_event.payload` but no read path returns it (the timeline
  summary is deliberately structured-only). Write-only for now.
- An issue already `resolved` before this change has no `IssueResolved`. No such rows exist in
  practice (nothing but tests reached `resolved`), so there is no backfill.
- `X-Actor-Id` is a free-form claim: a caller can send `system` or `ingestion`, which is
  indistinguishable in `actor_ref` from the system's own actors (the audit entry's `actor_type`
  stays `human`, which is the only thing that tells them apart). Part of the stub, gone with real auth.
- `prisma-issue-repository.ts` sits near the 400-line lint limit (the audit/resolution logic went
  into `prisma-transition-effects.ts` to stay under it). Any further growth needs extraction first.

## 001 T049/T050 — merge and unmerge: judgment calls, and what is not done

**Shape.** `merge(X into Y)`: X becomes `merged`; one `merged_into` row (subject X, `rule = human`);
one `merged` `issue_event` on X; outbox `IssueMerged` and `IssueStateChanged`. All in one
transaction, in `prisma-issue-merge.ts`. Unmerge sets `removed_at` (the row stays as history), puts X
back in the state it left, writes an `unmerged` event, publishes `IssueUnmerged` and
`IssueStateChanged`. A later merge writes a new row. Exposed as a **separate port**,
`IssueMergeRepository` (`PrismaIssueRepository` implements both), not as more methods on
`IssueRepository` — that interface has full hand-written stubs in `apps/api` and four test files, so
extending it forced edits outside this batch; a narrower port is also the `StalenessRepository`
precedent. Commands `mergeIssues` / `unmergeIssue` are thin scoping wrappers. No HTTP routes.

**State and row cannot disagree — made unrepresentable twice.** (1) `transitionIssue` now refuses
`to = merged` ("merge is its own operation"); `mergeTransition` / `unmergeTransition` are the only
doors, and merge writes the row, the state and the event in one transaction. (2) Migration
`20260928120000_merged_state_invariant` (with `down.sql`): deferred constraint triggers enforce
*state = merged ⇒ a live `merged_into` row* and *a live row ⇒ state merged or removed*, checked at
commit; plus the `CHECK (issue_id <> other_issue_id)` data-model.md always promised and nothing
enforced. Each clause was mutation-checked (assertions match the SQLSTATE `23514` and which invariant
fired, A or B, for UPDATE, INSERT and DELETE paths). **Existing rows:** constraint triggers do not judge
rows already there, and before this branch `transition(x, 'merged')` was legal and wrote no row. So the
migration opens with a `DO` block that **raises, naming the count and an example id, and installs
nothing** if any issue is `merged` with no live row (or has a live row while neither merged nor
removed). It cannot backfill — the target of such a merge is unrecorded — so a person decides per
issue. Proven in `issue-merge.e2e.test.ts` ("migration 20260928120000 refuses to run…") against a
database seeded with exactly such rows, on top of the prior migrations, and with consistent data. The
`CHECK` is added `NOT VALID` then `VALIDATE`d (asserted `convalidated`); this file runs as one
transaction under `migrate deploy`, so the `ACCESS EXCLUSIVE` lock of the `ADD` is still held to
commit — the split only pays off if it is ever applied statement by statement.

**Merged then removed (review fix).** `merged → removed` is a legal edge and the trigger allows
`removed` with a live row, so a removed issue keeps its row. That used to pin the survivor: the
"issues merged into it" check still counted the removed one, so `merge(Y, Z)` was refused for good.
Decided: the check ignores removed subjects (a join in the count; smallest change, and the row stays
as history, which withdrawing it on removal would not). Unmerging the removed issue is
`InvalidIssueTransitionError` (typed), and a repeat `merge(x, y)` after `x` was removed is refused
with the same error instead of reporting success. Tested both ways.

**Decisions on what a merge may touch.**

- Target itself merged or removed: **refused**. Source that other issues are merged into: **refused**.
  Together: merges are a forest of depth one, so "the survivor" is one issue, never a chain, and an
  unmerge never strands another. Racing `X→Y` with `Y→Z` cannot form a chain (row locks, tested).
- Source `removed`: refused by the graph. Source `merged` into the _same_ target: a no-op that says
  so — `merge` returns `outcome: 'already_merged'` (else `'merged'`), nothing is written, and the
  target and the reason are still validated. A repeat with a different reason or actor is accepted and
  **its reason and actor are dropped** (the first merge's are the record; the command's doc says so).
  Merged into a _different_ target: refused ("unmerge it first").
- `unmerge` returns `outcome: 'unmerged' | 'not_merged'`, a result rather than an error for an issue
  with no live row: a retry after success is indistinguishable from an unmerge of something never
  merged, and idempotent retries must not turn into failures.
- Target `resolved`: **allowed**. Cleaning up two resolved duplicates is the common case, but an open
  issue merged into a resolved survivor buries a live problem under a closed one. Not restricted;
  open for review.
- Source/target on another tenant, missing, or a malformed id: the same `NotFoundError('Issue')`.
  Component, environment, kind and fingerprint are deliberately **not** compared — the judgement is
  a person's (R-08), and the merge is reversible for that reason.
- `reason` is required, 1–500 chars (`MERGE_REASON_MAX_LENGTH`, a placeholder like every other limit,
  S0-7): it is the one free-text field in a payload the data model says is bounded.
- **Human only.** The row's `rule` is `human` and there is no `cause` parameter; a system or policy
  merge has no deterministic rule to name and no consumer. Not built.

**Counts and evidence.** Nothing moves at merge time — no evidence row, no `occurrence_count`, no
timestamp — so "unmerge restores counts to both sides, not split" holds because there is nothing to
restore. Tests: evidence rows byte-identical before merge / after merge / after unmerge; both counts
equal before and after; each side's timeline unchanged except for the `merged` / `unmerged` events.
Consequence, not a bug: while merged, the survivor's evidence view, count and timeline do not include
the merged issue's.

**Where the previous state lives.** On the `merged` event itself: `from_state`, plus
`payload.relationshipId` tying it to the row it created (so a merge → unmerge → merge cycle cannot be
confused with an earlier one; tested with two merges leaving different states). `issue_event` is
append-only in the database (R-03), so it cannot be edited away. Unmerge **fails closed** — nothing
changed — rather than guessing `detected`, with one typed error, `MergeIntegrityError`, whose
`reason` tells the cases apart, each reachable in a test: `merge_record_missing` (a row made by hand;
or an _older_ cycle's event exists but the live row's own does not), `relationship_vanished` (the row
was withdrawn by a writer that skipped the repository and the trigger while the unmerge held the
issue) and `merged_without_relationship`. An unmerge that would restore into an open state whose
fingerprint has been taken is `UnmergeFingerprintTakenError`, carrying the real fingerprint — not
`FingerprintAlreadyOpenError`, which `ingestSignal` reads as "attach to theirs". `resolved_at` /
`stale_at` are never touched, so the restored issue is field-for-field what it was.

**Concurrency.** Both rows are locked `FOR UPDATE` before either is read, so validation and write
see the same committed state. They are locked **one at a time in sorted-id order in code**: the
first version used one `ANY(...) ORDER BY id FOR UPDATE`, and removing that `ORDER BY` changed
nothing (the planner returns index order anyway), so it proved nothing; now reversing the sort fails
a test. Every race is forced with a held-open transaction and observed via `pg_stat_activity`
(`waitForBlocked`) rather than left to timing: overlapping merges; `X→Y` racing `Y→Z`; two unmerges;
a merge waiting for a state change that is mid-commit; a **committed merge racing a `transition`
that had already validated** (the transition fails with `ConcurrentModificationError`, overwrites
nothing — done deterministically by queueing the merge before the transition behind a held lock);
the lock-order probe (holder takes the higher id, the merge must already hold the lower:
`NOWAIT` on it fails `55P03`); and two forced **deadlocks** (an outside transaction with a long
`deadlock_timeout` so the merge/unmerge is always the victim). Removing `FOR UPDATE` fails all of them.
`40P01` / `40001` / `P2034` / `P2028` are translated to `ConcurrentModificationError` in a new
`prisma-concurrency.ts` — forcing the unmerge deadlock showed a typed-query deadlock arrives as an
_unclassified_ `PrismaClientUnknownRequestError` with the SQLSTATE only in its message, which the
mapper now handles (and `transition()`'s inline copy would not). **Dedupe with `transition()` once the
close branch that is editing it has merged.** Correlation is checked before the transaction opens
(a test shows a call outside a scope does not queue for a held lock); the events are also built
before the first write. This relies, like T051, on every writer of the `issue` row taking its lock
before writing. Ids are lower-cased in `merge` (an upper-case spelling of the same id used to give
`NotFoundError` because one id counted as two); `unmerge` takes a single id and needs no folding.

**OPEN — a signal whose fingerprint belongs to a merged issue.** Merging X frees X's slot in the
unique open-fingerprint index (`merged` is excluded), and `findOpenByFingerprint` no longer finds X.
So the next signal with X's fingerprint **opens a fresh issue X′ instead of attaching to the survivor
Y** — which is exactly the duplication a merge is meant to end. Worse, unmerging X back into an _open_
state then collides with X′; that case throws `UnmergeFingerprintTakenError`, leaves the merge in
place, and is tested (a `resolved` X unmerges fine beside an open X′ — a recurrence is legal). The
real fix is a product call I did not make: route signals of a merged fingerprint to the survivor
(which changes `ingestSignal`, the counts on Y, and what an unmerge would owe X) or leave it and
accept X′. Until then a merge only hides X; it does not absorb X's future.

**Audit trail — no `audit_entry` written.** Same reasoning as T042: `action` must be a registered
`policy_action.action_key` and 002 does not exist. The `issue_event` (`cause = human`, `actor_ref`,
`reason`, append-only) already answers who, when and why. **Inconsistent with the T052 branch**, which
writes an audit entry with the placeholder `evidence.retention_purge`; if that stands, adding
`issue.merge` / `issue.unmerge` is one `tx.auditEntry.create` in each function in
`prisma-issue-merge.ts`. I did not want a second unregistered key in an append-only table.

**OPEN — the survivor's own record of the merge.** The `merged` event is written on X only (the
`correlate` precedent). Y's timeline, evidence graph and audit show nothing, and
`projectIssueRelationships(Y, …)` reads `merged_into` only as a subject, so `GET /issues/{Y}` cannot
list what was merged into it. Timeline left unchanged as instructed; whether Y should show "X was
merged in" (an event on Y, or a union arm over `merged_into` rows) is not decided.

**Contract details.** `IssueUnmerged` carries `intoIssueId` only (the unmerge API has no body, so no
`reason`); `IssueMerged` carries `intoIssueId` and `reason`, both on the merged issue's own stream.
`IssueStateChanged` is published as well, because the contract says "any transition" and 002 reads it.

**Staleness and retention with merged issues.** The sweep skips `merged` (state-based, tested via
`findStaleCandidates`); an unmerged issue re-enters it with the unmerge event as fresh progress, so it
gets a full window. Retention (T052, in the other branch) selects by `tenant_id` and `expires_at` and
never looks at issue state, so a merged issue's evidence expires on its own schedule and stays with
its own issue. Nothing surprising; not run together here since the branches are separate.

**Known and left (review, recorded only).**

- LOW — the merged-state trigger checks the _new_ subject only, so an `UPDATE` that changes `issue_id`
  on a `merged_into` row does not re-check the old subject. Nothing in the repository does that.
- LOW — deferred-trigger violations are SQLSTATE `23514` raised at `COMMIT` with an internal message
  and are not translated; reachable only from writers that bypass the repository.
- LOW — the depth-one forest (no chains) is enforced by the application under row locks; the database
  has no wall for it.
- The `transition()` doc comment still cites `detected -> merged` as a legal race edge. It is now
  refused. Left alone because another branch is editing that method; fix the sentence when it merges
  (the e2e test itself now races `stale` against `investigating`).
- `prisma-issue-merge.ts` builds the `IssueStateChanged` event before the writes, `transition()` does
  after; harmonise when the two are deduped.

**Not done.** HTTP routes (`/merge`, `/unmerge` and their isolation tests, and `Idempotency-Key`
handling); OpenAPI; the ingestion routing above; anything in `apps/api`.

## Decisions waiting on Pavlo — phase 8 integration (index; the detail is in the named sections)

Nothing below blocks the work already done; each has a default in place and a cost if the default is
wrong. Ordered by how much a wrong default costs.

1. **A merge hides an issue but does not absorb its future signals.** A signal whose fingerprint
   belongs to a merged issue opens a *new* issue instead of attaching to the survivor, and the
   survivor's timeline / graph / `GET /issues/{id}` show nothing about what was merged into it.
   Fixing it changes ingestion's fingerprint lookup — a batch of its own. (`001 T049/T050`.)
2. **Cited evidence keeps its excerpt forever.** Retention detaches it but cannot purge it; whether
   a cited record should lose its text at expiry (a privileged scrub) is a decision about what
   FR-009's "support" requires. (`001 T052`.)
3. **A signal on a `stale` issue does not un-stale it.** The state graph has no edge out of `stale`,
   and `findOpenByFingerprint` counts it as open. (`001 T051`.)
4. **Nothing schedules the staleness sweep or evidence retention.** Both are routed in `apps/worker`
   and tested, but no code enqueues them: they need a tenant enumerator and a repeatable schedule
   (012's territory; a new pattern, so an ADR first). Until then both are correct and read by
   nothing. (`001 T051`, `001 T052`.)
5. **Audit action keys are invented placeholders.** `issue.close`, `evidence.retention_purge` and the
   merge path's absence of any audit entry are three different answers to the same gap: 002's closed
   `policy_action.action_key` list does not exist. Merge/unmerge writes no `audit_entry` at all,
   unlike close and purge. (`001 T057`, `001 T052`, `001 T049/T050`.)
6. **`@ApiOkResponse` is the first swagger decorator in `apps/api`.** It documents the
   `Idempotent-Replay` header; the dependency is already installed, but the rule is "new pattern ->
   ADR first". Keep it and write the ADR, or revert the decorator. (`001 T057`.)
7. **The human actor is a caller-asserted `X-Actor-Id` header** (free-form, can be `system` or
   `ingestion`), the same trust level as `X-Tenant-Id`: the auth layer carries only a tenant id.
   Real identity needs authentication, which does not exist. (`001 T057`.)
8. **`Idempotency-Key` is validated but not stored**, so "same key, different body -> 409" from the
   contract is not implemented; close is idempotent by state instead. A key table is a new pattern.
   (`001 T057`.)
9. **The 12 000-signal replay test times out in a full `make ci` when the machine is loaded**
   (load average 11-19 from other applications; it passes alone, also at load 19). Not
   investigated beyond that. If the pilot's CI shares a machine, this will be red there too.
10. **Publishing this work.** Everything for T045-T057 except T053/T056 sits on the local branch
    `worktree-001-phase8-staleness` (plus the two agent branches it merged), unpushed by instruction.
    Squash or keep the history, and when to run a full green `make ci` first, are yours to call.
