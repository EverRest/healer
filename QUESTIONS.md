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
operation.** Two concurrent *first* occurrences of a brand-new fingerprint could each see "not
found" and both create an issue — a real race, narrow (only matters for a fingerprint's very
first arrival) but real. Not fixed here: 001 T026 ("load check") is the task that would actually
exercise concurrent ingestion and notice if this matters in practice. A fix, if it turns out to:
a unique partial index on `(tenant_id, fingerprint) where state not in ('merged','removed')`,
catching the resulting unique-violation on `create` and retrying as an attach — one migration,
not a redesign.

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
