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
