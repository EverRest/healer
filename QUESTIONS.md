# Questions for tomorrow morning

Decisions I made autonomously while working through the backlog, flagged here instead of
interrupting. Delete entries once we've talked through them (or I've folded the answer into the
spec docs).

**Decision session 2026-09-27** — all entries below resolved. The binding decisions now live in
[decisions.md](docs/decisions.md) (C-43..C-47); this file keeps only the pointer plus what's still
genuinely undecided, since several other docs point back at this file by name for the reasoning.

**Decision session 2026-10-02** — a full walkthrough of every open item in this file with Pavlo,
one by one. Resolved items are individually tagged below with their decisions.md pointer
(C-72..C-90); everything left untagged is still genuinely open or still genuinely blocked (waiting
on 010's catalogue, a hosting target, real auth, S0-1's incident data, Phase 13's diff
infrastructure, or similar) — not re-litigated, just confirmed still accurate.

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

## 012 phase 6 — runner tasks T042, T045, T048–T051

001's repository/controller pattern (`packages/domain/issues`) and `apps/runner` having real
source have unblocked all six deferred phase-6 tasks (roadmap.md's own "Next" note, 2026-09-28).
All six (T042, T045, T046, T047, T048, T049–T051) are now landed in `worktree-012-runner`.

- **No registry or hosting exists for the runner image, and none is invented here.**
  `make runner-build` builds and tags the image locally and stamps version + digest
  ([ADR 0014](docs/adr/0014-runner-artifact-build-and-versioning.md)); pushing to a registry and
  publishing a customer-facing changelog entry stay manual, undecided steps until a registry is
  provisioned. Added to the index below.
- **Directive delivery is a heartbeat-response field, not a second inbound channel.** Outbound-only
  transport (T045, `contracts/runner-protocol.md`) rules out the control plane pushing a directive
  in; the runner's own heartbeat POST (T042) is the only outbound call it currently makes, so the
  control plane's heartbeat response carries `directives: DirectiveEnvelope[]` (pending, if any) —
  `DirectiveEnvelope` (`@healer/boundary-contract`), not a bare `ControlPlaneDirective[]`, since
  none of that union's seven variants carries an identifier and T051's dispatcher needs one (detail
  in "T045/T051 landed" below) — for T051's dispatcher to execute. No separate poll endpoint added
  — one outbound call serves both registration and directive collection.
- **T051's idempotency is runner-local, not control-plane-tracked.** The spec text is exactly "a
  directive arrives twice → execution is idempotent by directive identifier" — no requirement that
  the control plane know what was already executed. The dispatcher keeps a seen-set of directive
  ids (bounded, same drop-oldest shape as `OutboundBuffer`) and executes each id once; simplest
  mechanism that satisfies the stated contract without inventing a delivery-receipt protocol
  nothing yet asks for.
- **FR-020's resource state and clock offset are heartbeat payload fields, not new durable
  columns on `RunnerRegistration` by default.** `make runner-diagnostics` reads them from the
  runner's own local state (queue depths, timing histograms are runner-local per
  `contracts/runner-protocol.md`'s diagnostics section) — the control plane doesn't need a second
  copy to satisfy FR-020's "reports health... carrying resource state... clock offset" unless a
  control-plane-side consumer needs to query it, and none exists yet. If that turns out wrong,
  it's an additive migration, not a redesign.

### T042 landed — registration and heartbeat, judgment calls

`POST /runners/heartbeat` (`apps/api/src/runners/`), built in `worktree-012-runner`. `make ci`
green throughout (unit, e2e including a new testcontainers suite, all gates), `contracts-check`
regenerated and committed.

- **`RunnerRegistrationRepository` (interface + Prisma infra) lives in `apps/api/src/runners/`,
  not a shared package.** FR-001's closed package list has no domain package for the runner's own
  control-plane state (`packages/domain/*` maps 1:1 to numbered specs 001–011), and no second
  caller exists yet — `apps/worker` doesn't schedule anything against it (see below). The pure
  decision function, `findStaleRunners`, **does** live in a shared package
  (`packages/boundary-contract`, already the runner-protocol home) since it has no Prisma
  dependency and is genuinely reusable the moment a scheduler needs it. Deliberately did **not**
  put the Prisma-backed repository in `packages/boundary-contract` itself: that package is meant
  to be imported by `apps/runner` too (egress validation, T041, still unbuilt), and adding
  `@healer/prisma-client` there would be the first real leak of Prisma-adjacent code into what
  ships to the customer's execution plane. Promote this repository into a shared package (the same
  way `packages/domain/issues` is shared between `apps/api` and `apps/worker`) if and when a
  scheduled stale-runner sweep needs it there too.
- **`RunnerCapabilityResolution` is not written by registration or heartbeat.** Its `run_id`
  column is `NOT NULL` and the data-model doc describes the table as "why a given run behaved as
  it did" — a specific investigation run requesting a specific capability, not the periodic
  handshake. A heartbeat has no run to attach one to. T042 only upserts `runner_registration`; the
  resolution-row write is real work for whoever builds the first actual capability consumer
  (T093's `inference` capability is the likely first caller) — updated T043's own task line to say
  so plainly instead of leaving it pointing at T042 as the place that write would happen.
- **The handshake resolves against an empty `CapabilityRequirement[]` today.** No consumer
  declares a required capability yet (no directive dispatcher — T051, deferred; no collection-plan
  reader), so every heartbeat's status is driven purely by protocol-version compatibility
  (FR-018's own headline scenario, already covered exhaustively by T039/T044's handshake matrix) —
  never by a missing capability, since nothing is required yet. A real, non-empty list is real
  work for whichever task first needs one.
- **`name` was added to the heartbeat request body**, even though `contracts/runner-protocol.md`'s
  registration table only lists `protocolVersion`, `imageVersion`, `capabilities` and
  `resourceLimits`. `runner_registration` is unique on `(tenantId, name)` and nothing else in the
  documented wire format identifies which registered instance is calling — a real, small gap in
  the contract document, flagged here rather than guessed at silently; whoever next touches
  `runner-protocol.md`'s registration section should add it there too.
- **`resourceState`/`clockOffsetMs`/`lastSuccessfulTask`/`resourceLimits` are accepted, validated
  and read at the call site — never persisted or otherwise consumed.** The first two match this
  section's own earlier decision; `lastSuccessfulTask` (added after independent review, FR-020's
  prose names it but no document anywhere gives it a shape — accepted as loosely as
  `resourceState`, for the same reason) and `resourceLimits` (accepted from day one but never
  flagged here until now — same treatment, not a separate gap) get the identical treatment. An e2e
  test asserts the persisted row carries none of the four.
- **No e2e scenario exercises `resolveHandshake`'s `refused` status — corrected after independent
  review.** `CURRENT_PROTOCOL_VERSION` is `1`, the floor is two minor versions behind, and the
  request DTO correctly rejects a negative `protocolVersion` — so no schema-legal wire value can be
  two-plus versions behind today. Real coverage of the floor stays where it already exhaustively
  lives (`packages/boundary-contract/src/handshake.test.ts`). An earlier version of this note (and
  of the e2e test's own title) claimed the controller's pass-through of a `refused` result to the
  response and the persisted row was also proven here — it was not; the test only ever asserted the
  in-range, non-refused case. Both the test title and this note are now honest about the gap:
  whether `RunnersController` correctly carries a `refused` result and its `refusedReason` through
  is untested, not merely untested-and-claimed-otherwise. Closing it for real needs either a
  legitimate schema-legal way to breach the floor (none exists while
  `CURRENT_PROTOCOL_VERSION = 1`) or making the capability-requirement list (next bullet)
  injectable so a unit test can reach `refused` via a missing *write* capability instead of the
  version floor — not done here to avoid widening this fix's scope further.
- **`resolvedCapabilities` now resolves to the runner's own declared set when nothing is required
  — fixed after independent review.** With `NO_CAPABILITY_REQUIREMENTS = []`,
  `resolveHandshake`'s own `resolvedCapabilities` (computed from per-requirement resolutions) was
  always `[]`, regardless of what the runner declared — contradicting
  `contracts/runner-protocol.md`'s own words, "the resolved capability set — the intersection": the
  intersection with an empty requirement set is the declared set, not the empty set. The controller
  now returns the runner's declared capabilities when the status is not `refused` and no
  requirement is configured; `resolveHandshake` itself is untouched (it is correct and heavily
  relied on elsewhere) — this is a controller-level judgment about what "no requirements yet"
  should mean for the reply, not a semantic change to the shared function.
- **Two P2003/revocation findings from independent review, both fixed:**
  - `PrismaRunnerRegistrationRepository.upsert` had no handling for a syntactically-valid,
    non-existent `tenantId`. `runner_registration` is the first tenant-scoped table with a real
    foreign key to `tenant` (`issue` and friends have none yet), so this was new exposure, not an
    inherited gap — it surfaced as an unhandled `P2003`, an opaque 500 with **zero logging**
    (`apps/api` boots with `{logger: false}` and has no global exception filter). Now caught,
    logged via `createLogger()` at `warn` (`tenantId` is not secret) and translated to
    `NotFoundError('tenant')` (`@healer/shared`), which the controller maps to `404`.
  - The `update` branch unconditionally wrote `status` from the handshake result
    (`active`/`degraded`/`refused` only), so a heartbeat from a runner some future admin action had
    set to `revoked` would silently flip it back to `active` on its very next heartbeat — a
    revocation the revoked party could undo just by staying alive is not a control. Fixed at the
    query: `updateMany` now filters `status: { not: 'revoked' }`, so a revoked row is never written
    by this path at all; a genuinely new `(tenantId, name)` still creates one, and the narrow
    concurrent-first-heartbeat race (two initial heartbeats for the same brand-new name racing the
    `create`) is handled the same way `FingerprintAlreadyOpenError` handles the equivalent race for
    issues (001 T026) — re-read and return whichever one won, rather than surface an error a
    repeated heartbeat has no useful way to react to.
- **The stale-runner sweep is not scheduled anywhere.** Same gap as 001 T051/T052: no tenant
  enumerator and no repeatable schedule exist in `apps/worker` yet. `findStaleRunners` is built and
  unit-tested, and an e2e test proves it composes correctly against a real persisted
  `RunnerRegistrationSnapshot`, but nothing calls it on a schedule. Whoever wires 001 T051/T052's
  scheduler should wire this the same way, and can promote the Prisma repository above into a
  shared package at that point.

### T045/T051 landed — outbound-only transport and directive idempotency, judgment calls

`apps/runner` has real source now: `heartbeat-client.ts` (the outbound POST), `directive-
dispatcher.ts` (the idempotency mechanism), `main.ts` (wires both on an interval). Two independent
reviews of the first version of this work found real bugs, listed below alongside the surviving
judgment calls; both rounds of fixes are already applied. `pnpm run typecheck`, `lint`,
`format-check` and `test-unit` all green; `runner-contract-test`/`runner-compat-test` unaffected
and still green.

- **`DirectiveEnvelope` lives in `@healer/boundary-contract`, not in `apps/runner`.**
  `ControlPlaneDirective`'s closed union carries no identifier field on any of its seven variants,
  yet `runner-protocol.md`'s failure-behaviour section and FR-028 require idempotency "by directive
  identifier" — a real gap between the contract document's prose and its own schema, same shape as
  T042's undocumented `name` field. Not invented away by adding an `id` into the closed union
  itself (that union is FR-022's single authority for what crosses the boundary, reviewed like the
  rest of the document). The first version of this fix defined `DirectiveEnvelope` only inside
  `apps/runner` — caught by review: `RunnersController`'s own response type was still `directives:
  readonly never[]`, so nothing forced the two sides to agree, and a future producer following this
  file's own older wording ("carries `ControlPlaneDirective[]`") instead of the runner's actual code
  would have made every real heartbeat response fail the runner's independent validation forever.
  Fixed: `DirectiveEnvelope` (and its zod schema) now live in `@healer/boundary-contract` — the one
  authority both `RunnersController.directives` (typed `readonly DirectiveEnvelope[]`, still always
  `[]`) and `apps/runner`'s dispatcher/heartbeat-client import from. Since no real producer exists
  yet, this is still exercised only at the unit-test level on both sides, not proven end-to-end —
  honest, per this section's own "the mechanism, not the full pipeline" framing.
- **Directive execution is idempotent, not directive *attempt*** — a real bug, caught by review.
  The first version marked a directive's id seen *before* calling its handler, so a handler that
  threw left the id permanently unretriable, and the throw aborted the rest of that response's
  directives mid-loop with no `directiveId`/`directiveKind` in the log. `dispatchDirectives`
  (`directive-dispatcher.ts`) now marks an id seen only after its handler *succeeds*; each
  directive's handler call is wrapped in its own try/catch, logged with `{directiveId,
  directiveKind, err}` on failure, and does not stop the rest of the batch. Tested directly: a
  throwing handler leaves the id unseen and retryable on redelivery, and a later directive in the
  same batch still runs despite an earlier one throwing.
- **The seen-set's recency-refresh path was dead code on the real call path** — a second bug, also
  caught by review. `dispatchDirectives`'s loop did `if (seen.hasSeen(id)) continue;` and never
  called `markSeen` again on a hit, so `BoundedSeenSet`'s refresh-on-redelivery logic (described
  below) never actually ran: a still-pending directive redelivered on every heartbeat would be
  evicted the moment enough *other* distinct ids arrived, and then re-executed — precisely what
  T051 exists to prevent. Fixed: the hit branch now calls `seen.markSeen(id)` before `continue`,
  refreshing recency on every redelivery. Tested directly with a scenario that would have caught
  this: one id redelivered while more than the bound's worth of other distinct ids pass through —
  it is never re-executed.
- **The directive seen-set is a dedicated `BoundedSeenSet`, not `OutboundBuffer<string>`.** Both
  share one policy — evict the oldest entry once bounded — but `OutboundBuffer` has no lookup
  operation at all, only `push`/`drain` for a queue meant to be emptied wholesale; idempotency needs
  `hasSeen` (a membership test). `BoundedSeenSet` (`directive-dispatcher.ts`) is a ~25-line `Set` +
  order array. Its own bound is `RUNNER_DIRECTIVE_SEEN_SET_SIZE`, a constant independent of the
  heartbeat's own sizing (a first version reused a heartbeat-buffer constant for this — flagged by
  review as two unrelated things sharing one unrelated number) — a placeholder, same status as
  every other un-measured bound in this codebase.
- **`OutboundBuffer` was removed from the heartbeat path entirely** — an architectural finding from
  review, not just a bug fix. The contract puts buffering on outbound *evidence* (FR-021), not on
  heartbeats: a heartbeat is a pure liveness signal built fresh from static config every time
  (`buildHeartbeatPayload` reads only `config`), so replaying a stale one after an outage is a
  byte-identical duplicate that recovers nothing. Buffering it anyway cost two real things: up to
  `RUNNER_BUFFER_SIZE` redundant identical POSTs fired back-to-back after an outage, each stamping a
  fresh `lastHeartbeatAt`; and a genuine bug — directives were only ever dispatched from the *last*
  drained response (`index === pending.length - 1`), so every buffered response's directives except
  the final one were silently discarded, and a failing *current* heartbeat discarded that cycle's
  directives too. Harmless only because the controller always returns `[]` today; would have been
  silent directive loss the moment a real producer existed. Fixed: a failed heartbeat tick just logs
  a warning and waits for the next interval; directives are dispatched unconditionally on every
  successful response. `OutboundBuffer` stays reserved for real evidence submission (below), which
  is what FR-021 actually describes.
- **The heartbeat response's `status`/`refusedReason`/`resolvedCapabilities` are now read, not just
  validated and discarded** — a real bug, caught by review. The control plane can reply
  `{status: 'refused', ...}` with a plain HTTP 200; nothing about the transport fails, so the first
  version of `runHeartbeatCycle` kept heartbeating "successfully" forever while doing nothing useful
  and logging nothing about it — exactly the "debug it blind" failure this user story exists to
  prevent, and a direct contradiction of the compatibility table's own "never silently degraded"
  wording (FR-018). Fixed: `runHeartbeatCycle` now logs at `warn` for `degraded` and `error` for
  `refused`, carrying `{status, refusedReason, resolvedCapabilities}`; `active` logs nothing extra.
- **`sendHeartbeat` now binds `AbortSignal.timeout(...)`** to its `fetch` call, at half the
  configured heartbeat interval with a 1s floor — a cheap fix flagged by review: without it, a hung
  control plane (not a refused/errored response, an actually-stuck connection) would leave ticks
  piling up with no bound.
- **Real evidence submission (`RunnerEvidence`) has no receiving endpoint** — grepped `apps/api/src`
  for one; `/ingest/signals` (001) accepts a different, provider-pushed `Signal` shape, not
  `RunnerEvidence`. Same gap shape as T042's own "directives have no producer" note: not invented
  here. T045 is scoped to the transport *mechanism* (the outbound-only heartbeat POST loop), not to
  a feature with nothing to send yet. Whoever builds the first real evidence-producing task is also
  the one who needs a `POST /runners/evidence`-shaped endpoint on the control plane, and is the
  first real user of `OutboundBuffer` on the runner side (kept reserved for exactly this, above) —
  `heartbeat-client.ts`'s `sendHeartbeat` is the pattern to follow for the transport itself (native
  `fetch`, independently validated at ingress and egress per FR-022, bounded by an abort signal).
- **`apps/runner` needed its own config-loading convention, not `loadConfig()`.** The existing
  `loadConfig()` (`packages/shared/src/config/index.ts`) hard-requires `DATABASE_URL`/`REDIS_URL` —
  every other deployable in this repo has both. The runner must not: "no direct database access,
  ever" is an inviolable rule (`.claude/rules/backend-nestjs.md`), and requiring a Postgres/Redis
  URL just to start the process would be a standing lie about what it touches. Added a second,
  separate schema and `loadRunnerConfig()` function in the *same file* — not a new authorized
  location — since the lint rule's `no-restricted-syntax` ignore pattern is anchored literally to
  `packages/shared/src/config/**` (a directory, not a per-app pattern); two schemas in one
  already-authorized directory is the smaller diff than widening the lint rule's own ignore list
  for a second location.
- **No `build`/`start` script was added to `apps/runner/package.json`.** Checked `apps/worker`'s
  package.json first (the closest precedent, also a plain-process deployable): it has neither
  either — the repo-wide `build`/`typecheck` scripts already build every app via `tsc --build`'s
  project references, and no app in this repo has a `start` script yet (a real gap, same one
  flagged for release/deployment automation elsewhere in this file). Not invented here to avoid a
  one-off convention that diverges from `apps/worker`'s own shape.
- **A persistently-failing directive retries forever, logged at `error` on every occurrence, with no
  retry-count cap or dead-letter concept.** Checked against FR-028's actual text ("idempotent under
  re-delivery, keyed so re-running produces no duplicate effect") — that's the whole requirement,
  and this satisfies it exactly; a retry ceiling isn't asked for. Flagged by the confirmation review
  as a legitimate operational follow-up (infinite log spam for a directive nothing can ever execute
  successfully), not a defect in what T051 was scoped to build. Worth an ADR if/when a real directive
  producer (T093+) makes this a live operational concern; not decided here.

### T049/T050 landed — runner image, `make runner-build`, Docker Compose wrapper

`apps/runner/Dockerfile`, `docker-compose.runner.yml`, `scripts/runner-build.mjs` (ADR 0014).
`typecheck`/`lint`/`format-check`/`test-unit` green; the two new Docker-backed e2e tests (gated
into `vitest.config.ts`'s `HEAVY_E2E`, same mechanism the four existing heavy e2e files use) pass
against real Docker. `make runner-build` run for real, refusal and stamp-file behaviour verified
manually (see the commit/PR description for pasted output).

- **Scoped `pnpm --filter`, not the whole monorepo, for the Dockerfile's build stage — a real
  reason, not just a leaner-image preference.** `apps/runner` depends on exactly two workspace
  packages (`@healer/boundary-contract`, `@healer/shared`; its own `tsconfig.json` already
  declares this as its full `references` graph). The root `pnpm run build` script
  (`tsc --build tsconfig.json`) builds *every* referenced project, including
  `packages/prisma-client`, which requires a generated Prisma client
  (`link:../../prisma/generated/client`, produced by `pnpm run db-generate`) before it will even
  typecheck — confirmed empirically: a fresh worktree's `pnpm run typecheck` fails outright with
  `Cannot find module '@healer/prisma-generated'` until `db-generate` runs once. That's a
  network-and-schema-dependent step with nothing to do with the runner, and pulling it into the
  runner's own image build is exactly the kind of accidental coupling scoping avoids. The build
  stage instead runs `pnpm install --frozen-lockfile --filter "@healer/runner..." --filter "{.}"`
  (root, for `tsc` itself) then `tsc --build apps/runner/tsconfig.json` directly — the same
  `tsc --build` mechanism the root script uses, just pointed at the project-reference subgraph
  TypeScript's own build system already knows is correct, not a hand-rolled second build.
- **`pnpm install --filter "<pkg>..."` still installs the workspace ROOT project's own
  `dependencies`, even without the root selected — confirmed empirically, not documented pnpm
  behaviour I could find.** `pnpm list --filter "@healer/runner..."` excludes the root project as
  expected, but the equivalent `pnpm install` does not: the root package.json's own
  `dependencies` (`@prisma/client`, `supertest`, `@types/supertest` — nothing to do with the
  runner) land in `/repo/node_modules` regardless. Tried `--filter "!{.}"` as an explicit
  exclusion; it made no observable difference. Worked around it rather than fighting pnpm further:
  the runtime image copies only `node_modules/.pnpm` (pnpm's content-addressed virtual store, the
  thing every package's own local `node_modules` symlinks actually resolve into) from the
  `prod-deps` stage, never the top-level `/repo/node_modules` — so root's unrelated direct
  dependencies are simply never copied, whatever pnpm installed alongside them. Confirmed by
  inspecting the built image: `apps/runner/node_modules` and `packages/{shared,boundary-contract}
  /node_modules` contain exactly their own declared deps (`zod`, `pino`, `@opentelemetry/*`),
  nothing from root.
- **`docker-compose.runner.yml` lives at the repo root**, not `apps/runner/` or `docker/`. ADR
  0014 names the file exactly this way (not `docker/docker-compose.runner.yml`) — the `.runner`
  suffix is already the distinguishing mark from the dev-only `docker/docker-compose.yml`, and a
  repo-root compose file is what `docker compose -f docker-compose.runner.yml up` expects by
  convention without an extra `-f docker/...` path for whoever runs it.
- **The compose file's `environment:` is list form, not map form — a correctness fix, not a style
  choice.** A map-form `RUNNER_PROTOCOL_VERSION: ${RUNNER_PROTOCOL_VERSION:-}` sets the container's
  env var to an *empty string* when the host doesn't set it, and `loadRunnerConfig`'s
  `z.coerce.number().min(1)` for that field rejects an empty string outright instead of falling
  through to its documented default of `1` — every optional field would have broken the same way.
  List-form bare entries (`- RUNNER_PROTOCOL_VERSION`) pass a variable through only when the host
  actually sets it and omit it entirely otherwise, letting `loadRunnerConfig`'s own defaults apply
  inside the container. Verified directly: built the image, ran it via `docker compose run` with
  only the three required variables set, confirmed via `env` inside the container that none of the
  optional ones were present (not even as empty strings).
- **Found and fixed a real gap in `apps/runner/src/main.ts`'s SIGTERM handling — not just
  confirmed adequate.** `RunnerHandle.close()` was a synchronous `clearInterval(interval)`, and the
  process-level `stop()` called it then `process.exit(0)` immediately — no await, nothing waiting
  for a heartbeat cycle already in flight to finish. That directly contradicts FR-019's "upgrade
  without losing in-flight work: draining current tasks." Fixed by tracking the in-flight tick's
  promise and making `close()` async, racing it against a bounded `DRAIN_TIMEOUT_MS` (10s) so a
  genuinely hung request can't block shutdown forever. Covered by a new unit test in
  `apps/runner/src/main.test.ts` (delays a mocked `fetch`, asserts `close()` does not resolve until
  it settles) and proven end to end by `apps/runner/runner-image.e2e.test.ts`: real container, real
  `docker stop -t 15`, exits cleanly in ~2s, `ExitCode=0`.
- **The refuse-rebuild-in-place mechanism builds to a throwaway candidate tag first
  (`healer-runner:<version>--candidate-<pid>-<ts>`), and only moves the real
  `healer-runner:<version>` tag onto it once the comparison passes.** Building straight to the
  final tag and comparing after would mean the violation already happened on disk (the tag would
  already point at the new, rejected content) before the script could refuse anything. The
  candidate approach means a refused rebuild leaves the existing tagged image completely
  untouched — verified in `scripts/runner-build.e2e.test.ts` by re-inspecting the original tag's
  digest after a refusal and asserting it is unchanged.
- **`runnerBuild(version, { repoRoot, stampPath })` takes both as optional, injectable
  parameters** rather than reading `apps/runner/package.json` and writing the real
  `apps/runner/dist/runner-release.json` unconditionally. The CLI entrypoint (`isMainModule` guard)
  always uses the real paths; `scripts/runner-build.e2e.test.ts` passes synthetic versions and a
  scratch-directory stamp path so the automated test suite never touches the real stamp file or
  risks colliding with a version a developer might have manually tagged locally.
- **Publishing (pushing to a registry) is still out of scope, unchanged from ADR 0014** — this
  task only builds and tags locally, per the existing QUESTIONS.md item 14 (No registry exists).

**Review round 2 (two independent reviews found real, reproduced bugs — .dockerignore not
actually excluding nested `dist`/`node_modules` broke the "identical rebuild is a no-op"
guarantee, and the runtime image genuinely contained Prisma/TypeScript/devDependencies) — both
fixed and personally re-verified with real Docker (same digest twice, zero Prisma content in the
built image). A confirmation review then found one further real gap, fixed directly rather than
routed through another agent round-trip, given both fixes were small and needed no Docker to
verify:**

- **The drain-timeout/`stop_grace_period` relationship was a guarantee with no reader.**
  `drainTimeoutMs` (derived from `computeHeartbeatTimeoutMs`) only stays under
  `docker-compose.runner.yml`'s fixed 20s `stop_grace_period` at the *default*
  `RUNNER_HEARTBEAT_INTERVAL_MS` — nothing stopped an operator from raising the interval far enough
  to push the derived drain timeout past 20s, silently reintroducing the exact "SIGKILL before
  `close()`'s drain finishes" bug the first review round fixed. The compose file's own comment
  already named this risk; nothing enforced it (`AGENTS.md`: "every guarantee names its reader").
  Fixed by making the unsafe value unrepresentable rather than documenting it harder:
  `packages/shared/src/config/index.ts`'s `RUNNER_HEARTBEAT_INTERVAL_MS` now has `.max(32_000)` — the
  exact ceiling at which `floor(32_000 * 0.5) + 2_000 = 18_000ms`, two full seconds under the 20s
  grace period. `loadRunnerConfig` can't import `computeHeartbeatTimeoutMs` directly (that would be
  a `packages/shared` → `apps/runner` dependency, backwards for this monorepo's layering), so the
  cap is the formula's *result*, restated with the derivation spelled out in a comment that
  cross-references both `main.ts` and the compose file by name — raising any of the three numbers
  (the cap, the safety margin, or the grace period) requires checking the other two, a real but
  unavoidable three-file coupling given the layering constraint.
- **`scripts/prune-runner-store.mjs`'s reachable-set computation only walked `dependencies`, never
  `optionalDependencies`.** Not a live bug (confirmed via a real `pnpm list --json` run against this
  repo's actual tree: no `optionalDependencies` key exists anywhere in it today), but a real latent
  one: a future optional dependency (e.g. a native-binding package like `fsevents`) would be
  silently pruned as "unreachable" the moment one appeared, producing a working-until-it-isn't
  `MODULE_NOT_FOUND` in production with no warning. Fixed: `collectStoreKeys` now walks both
  `dependencies` and `optionalDependencies` at every level, recursively.
- **Cosmetic, not fixed**: the built image still contains a handful of zero-byte dangling symlinks
  under `node_modules/.pnpm/node_modules/@prisma/*`, pointing at store directories
  `prune-runner-store.mjs` already deleted. Confirmed via `du`/`find` inside the built image that no
  real Prisma file content remains anywhere — this is purely leftover symlink aliases with nothing
  behind them, not a functional leak. Not worth a third fix round; noted here in case a future
  `find -iname '*prisma*'`-style audit of the image is confused by it.
- **`runner-image.e2e.test.ts`'s hang detection was redesigned, not just given a bigger number,
  after three reproduced failures under host contention (35→40.1s, then 35→90.1s after widening to
  80, on two separate `make ci`/isolated runs, with no competing processes from this session each
  time).** Root cause: `waitForExit`'s `elapsedSeconds` conflated two different things —
  `waitFor` returns once its deadline passes *regardless of the predicate's final value*, so a
  container that genuinely never exits and one that exits slowly under real host contention (other
  processes on this shared machine, confirmed via `ps aux`/`top` each time, not this session's own
  work) produced the *identical* observable shape: a large elapsed number. Every widening of the
  upper bound was chasing a symptom a fixed timing assertion structurally cannot distinguish from
  the real failure it exists to catch. Fixed properly: `waitForExit` now returns `{exited,
  elapsedSeconds}` — `exited` (did the container actually leave `running` within a generous 120s
  poll ceiling) is the real hang detector, asserted directly (`expect(exited).toBe(true)`, with the
  elapsed time in the failure message for diagnosis); `elapsedSeconds` is kept only where it proves
  something contention can't fake (`toBeGreaterThan(2)`, ruling out the pre-fix immediate,
  un-drained exit) and dropped everywhere it was only ever asserting "not too slow today," which
  contention can and did fake as "hung." No change to production code — only to what a timing-based
  e2e assertion on a shared, contended machine is actually able to prove.

**Still flaky after the redesign above — open issue, not silenced.** The boolean `exited` check
itself then failed twice more (once at the 120s poll ceiling with `exited: false`, once again after
a further fix below), each time paired with `[vitest-worker]: Timeout calling "onTaskUpdate"` — a
symptom of the *test runner's own* coordination channel starving, not obviously the container
itself. Investigating that symptom found a real, separate bug: `waitFor`'s poll loop called
`spawnSync('sleep', ...)` — synchronous, blocking Node's entire event loop for the full interval on
every single poll (up to ~600 back-to-back blocking spawns at a 120s/200ms budget), which plausibly
starves vitest's own RPC regardless of host load. Fixed: `waitFor`/`waitForExit` are now `async`,
sleeping via a non-blocking `setTimeout` instead of `spawnSync`. This is a genuine, real fix — but
re-verification failed a **fifth** time with the identical symptom, meaning `spawnSync` inside
`docker()` itself (still used for every actual `docker inspect`/`exec` call, not just the sleep) can
still block the event loop for however long a contended Docker daemon takes to respond, which the
async sleep fix does not touch.

**Decision (with Pavlo, 2026-09-30): stop iterating locally, push now, add real CI separately.**
Five fix attempts across four genuinely different, defensible causes (widen bounds ×2, redesign the
assertion from timing to a boolean, fix real event-loop starvation) each addressed something real
without resolving the flakiness — strong evidence this is this shared, contended dev machine, not
a logic bug in the runner or an easy test mistake. The drain mechanism itself already has
independent proof: a fast, deterministic unit test (`apps/runner/src/main.test.ts`, no Docker,
runs in milliseconds) exercises the same `close()` logic directly, plus multiple manual `docker
exec`/`docker inspect` verifications earlier in this phase's work all showed correct ~2-6s exits.
Proceeding with the rebase and push now rather than continuing to guess; a GitHub Actions workflow
(a genuinely new pattern for this repo — needs its own ADR before or alongside it) running the full
`make ci` on push/PR is the next piece of work, on a GitHub-hosted runner with its own Docker,
which may simply not share this machine's contention profile at all.

**Fix options for the still-open flakiness (not yet chosen, listed for when this is revisited)**:

1. Make the `docker()` helper itself fully async (`execFile`-based, not `spawnSync`) everywhere in
   this file, not just in the poll loop's sleep — addresses the actual remaining blocking-call
   surface the event-loop fix above didn't reach.
2. Replace polling `docker inspect` with `docker events --filter container=<id> --filter event=die`
   — reacts to the real OS-level event instead of repeatedly asking, removing the poll loop (and
   its blocking-call risk) entirely. More correct, larger rewrite.
3. Wrap just this one test in vitest's per-test `retry` option — honest for "infra-flaky, not a
   logic bug," but does not fix the root cause and could still fail if contention outlasts the
   retry budget (this machine has shown contention lasting minutes at a time).
4. Remove the sidecar slow-HTTP-server container from this test's critical path (simulate the delay
   some other way) — fewer Docker operations in flight, smaller contention surface, but doesn't
   eliminate it.
5. Move this specific test out of `make ci`'s default path into an opt-in/manual target — the drain
   property already has independent proof (the unit test + prior manual verification above), so
   losing this one e2e as a default gate is a real but bounded loss, not the only proof left.

## Decisions waiting on Pavlo — 012 phase 6 (index; detail in the named sections above)

1. **`runner-image.e2e.test.ts`'s "genuinely drains an in-flight heartbeat" test is flaky on this
   shared dev machine** — five fix attempts (two bound widenings, a timing-to-boolean redesign, a
   real event-loop-starvation fix) each addressed something genuine without resolving it. Decided
   2026-09-30: not blocking this push; five fix options are listed above, none chosen yet. Revisit
   once real CI exists and can show whether it reproduces there too.
2. **No registry or hosting is provisioned for the runner image** (unchanged from item 14 in the
   001/012 phase-8 index above) — `make runner-build` stops at a local tagged image; pushing it
   anywhere is a manual, undecided step.

### Second rebase (onto 51d78e8, 002-policy) — a real regression found and fixed, not the known flake

Rebasing this branch onto master after 002-policy landed (which independently added its own
`createApiModule` parameters — three policy repositories) surfaced a genuine bug the rebase itself
introduced, distinct from the already-documented flaky Docker test above:

- **`apps/api/runners.e2e.test.ts`'s `createApiModule(...)` call silently passed
  `runnerRegistrations` into the `policyRulesets` parameter slot** — every `POST /runners/heartbeat`
  request 500'd. Root cause: this file exists only on the 012-runner side of the rebase (002-policy
  never touched or created it), so git carried it through both rebases with zero conflict markers —
  nothing flagged it for a human to reconcile, even though the shared `createApiModule` signature it
  calls had grown three new required parameters on the other side. A missing-argument call like this
  would normally be a TypeScript error, but `apps/api/tsconfig.json`'s `include: ["src/**/*"]` does
  not cover this file (it lives at `apps/api/runners.e2e.test.ts`, not under `src/`) — the same is
  true of every other root-level `*.e2e.test.ts` file in this app, so none of them are type-checked
  by `pnpm run typecheck` at all; only actually running them catches a signature drift like this one.
  Fixed by adding the three `PrismaPolicyRulesetRepository`/`PrismaPolicyDecisionRepository`/
  `PrismaPolicyActionRepository` imports and instances in the correct position, matching the pattern
  every other real-Postgres e2e file in this app already uses. Verified: 11/11 tests pass afterward,
  and a full `e2e` project run found no other file with the same gap.
- **Fixed 2026-10-02, see [decisions.md](docs/decisions.md) C-89**: `@healer/domain-policy` is imported by `apps/api/src/main.ts`
  (and by several e2e test files) but is not declared in `apps/api/package.json`'s `dependencies` or
  `apps/api/tsconfig.json`'s project `references` — it resolves today only via pnpm's workspace
  hoisting, not an explicit dependency edge. Works, but is exactly the "phantom dependency" pnpm's
  own strict-mode isolation exists to prevent; worth a real fix (add the declared dependency and
  tsconfig reference) whenever 002-policy's own follow-up work touches this app's manifest, not
  invented as a scope-creeping fix here.
- **Also seen during the full `e2e` project run, confirmed as the already-known flake, not new**:
  `apps/api/issue-close-and-views.e2e.test.ts`'s two `/audit`/`/timeline` assertions failed once
  under the full suite's combined load, then passed cleanly in isolation both times re-run — matches
  004's own roadmap note ("the one flaky signal was 001's own previously-known load-sensitive replay
  test, confirmed transient by isolated retry"), not a new regression from this rebase.

### T048 landed — `make runner-diagnostics`, the last deferred phase-6 task

`packages/boundary-contract/src/diagnostics.ts` (pure bundle shape + assembler),
`apps/runner/src/diagnostics-state.ts` (runner-local accumulation), `apps/runner/src/main.ts`
(instrumentation + `SIGUSR2` dump-to-file), `scripts/runner-diagnostics.mjs` (`make
runner-diagnostics`). `typecheck`/`lint`/`format-check`/`test-unit` all green (515 tests); the
FR-023 planted-marker test applied to this bundle (FR-024's own explicit requirement) passes; a
plain-process (non-Docker) e2e test proves the real `SIGUSR2`-dump-and-read cycle against a
spawned, compiled runner, and the finished target was also run by hand against a live spawned
runner (pasted output below) and against no runner at all (fails clearly, both for an absent
pidfile and for a stale one naming a dead pid).

- **No listening socket, ever — a signal plus a file, not an admin endpoint.** The task's own
  framing already ruled this out explicitly, and it is the one constraint this whole feature (T045)
  exists to guarantee; `SIGUSR2` on the exact precedent already set by `SIGTERM`/`SIGINT` in
  `main.ts`, dumping to a local file, is the outbound-only-compatible equivalent. `close()` now also
  does `process.off('SIGUSR2', ...)` and removes the pidfile — hygiene `SIGTERM`/`SIGINT`'s own
  process-level `process.exit(0)` never needed, since this handler is registered per-`start()` call
  and `start()` is called directly (and repeatedly, across tests) outside the CLI guard too.
- **Where the pure bundle shape lives: `packages/boundary-contract`, not `apps/runner`** — same
  precedent as `handshake.ts`/`runner-registration.ts`: a pure shape plus a pure assembler with no
  process state, importable without pulling in Prisma or anything runner-process-specific.
  Deliberately decoupled from `RunnerConfig` itself (the builder takes plain primitives, not a
  `RunnerConfig` object) so this package gains no new dependency on `@healer/shared` for it. The
  *stateful* accumulation (the histogram, the ring buffer, the error tally) is genuinely
  runner-process-specific and lives in `apps/runner/src/diagnostics-state.ts` instead — the same
  split T042 already drew between `findStaleRunners` (shared, pure) and its Prisma repository
  (`apps/api`-local).
- **"Configuration reduced to presence-only" — solved by reading `source` directly, not by
  widening `loadRunnerConfig`'s return type.** `loadRunnerConfig`'s frozen, parsed `RunnerConfig`
  cannot distinguish an explicit value from a default that happens to match it once parsed. Added
  `getRunnerConfigPresence(source)` (same file, same `source` parameter `loadRunnerConfig` already
  takes) that derives the key list from `runnerSchema.shape` — one authority, not a second
  hand-maintained key array — and reports `'set'` when `Object.hasOwn(source, key)`, `'default'`
  otherwise. Never the value, by construction: the function's own return type has no slot for one.
- **A new config key, `RUNNER_DIAGNOSTICS_DIR`, not a hardcoded `apps/runner/dist/` path** — a
  real correctness finding, not a style preference. `apps/runner/Dockerfile`'s runtime stage `COPY`s
  `apps/runner/dist` as `root` and then runs as `USER node` (a deliberate T050 hardening); a
  non-root process cannot write a diagnostics dump or pidfile into a root-owned directory there
  without an image change this task has no reason to make. Defaults to `os.tmpdir()` (writable by
  the runtime user both in a plain process and in the shipped Alpine image), configurable so a host
  running more than one runner instance — or this feature's own e2e test — can give each instance
  its own path instead of colliding on one fixed file. Threaded through the schema like every other
  runner config value, not read directly in `main.ts` (the `process.env`-outside-`shared/config`
  lint rule, R-01, applies to every `.ts` file, this one included).
- **`make runner-diagnostics` finds the runner purely by PID — an explicit argument, `RUNNER_PID`,
  or a pidfile the runner writes at startup (`RUNNER_PIDFILE` overrides its path).** There is no
  registry or query endpoint to find a runner another way (same gap as "no registry exists for the
  runner image" above, now also true of runner *processes*). This only reaches a process the
  script's own OS can signal directly — a bare process, or a container run with a shared PID
  namespace (`docker run --pid=host`). **A container run under Compose's own default, separate PID
  namespace is a known, unsolved limitation**: `docker exec <container> kill -USR2 1` plus reading
  the file back via a mounted volume or `docker cp`/`docker exec cat` is the equivalent there, not
  built by this script — consistent with this task's own explicit guidance to avoid deep Docker
  involvement for a diagnostics convenience, and worth a follow-up if/when `make runner-diagnostics`
  needs to reach a Compose-deployed runner directly rather than one run locally for support.
- **The FR-024 fields this bundle does not carry — `task outcomes`, `resource statistics`,
  `contract-rejection counts`, `clock offset` — named in the spec's FR-024 prose but not in
  `contracts/runner-protocol.md`'s own, more operational Diagnostics (R-06) section, and not built
  here.** No task execution capability exists yet (T093+), no resource-statistics collector exists,
  no contract-rejection counter exists, and no clock-offset field currently flows through the
  heartbeat request at all (`buildHeartbeatPayload` in `heartbeat-client.ts` sends `name`,
  `protocolVersion`, `imageVersion`, `capabilities`, `resourceLimits` — nothing else). This mirrors
  T045's own "real evidence submission has no receiving endpoint yet" and T042's "the handshake
  resolves against an empty requirement list" — reporting what is real rather than fabricating a
  field with nothing behind it (AGENTS.md: source trust and honesty about gaps). The task's own
  "What to build" list matches R-06's narrower, buildable set exactly; whoever adds task execution,
  resource-statistics collection or clock-offset reporting to the heartbeat is also the one who
  extends this bundle to carry them.
- **The last-N-exchanges bound (`MAX_RECENT_EXCHANGES = 20`, `diagnostics-state.ts`) and the
  histogram's eight fixed buckets are placeholders**, same status as `RUNNER_DIRECTIVE_SEEN_SET_SIZE`
  and every other un-measured bound in this codebase — no real fleet exists yet to measure a useful
  support window or latency distribution against.
- **No metrics library** — a fixed bucket array plus a plain counter array is the whole histogram;
  nothing here needed a new dependency.
- **Docker was not needed for the signal-dump-and-read cycle itself** — a plain `child_process.spawn`
  of the compiled `apps/runner/dist/main.js`, real `SIGUSR2`, real file read
  (`apps/runner/main-diagnostics.e2e.test.ts`) proves the exact same `main.ts` signal-handling logic
  a Docker container would, without the multi-hour host-contention cost this session's other Docker
  work already paid (`runner-image.e2e.test.ts`'s own doc comment). The test builds
  `apps/runner/dist/main.js` itself in `beforeAll` (same self-contained-build precedent as that file
  and `scripts/runner-build.e2e.test.ts`) so it does not depend on an earlier `pnpm run
  build`/`typecheck` already having run. One real bug caught while writing it: polling
  `child.exitCode`/`child.signalCode` (Node-internal state, only updated once Node's own event loop
  processes the spawned child's exit) with a *blocking* `execFileSync('sleep', ...)` poll loop never
  works, because the blocking call never lets that event loop run — unlike polling *external* state
  (`existsSync`, or `runner-image.e2e.test.ts`'s own `docker inspect` calls), which does not depend
  on this process's own event loop turning over at all. Fixed by polling with a real, non-blocking
  `await` (`node:timers/promises`'s `setTimeout`) instead.
- **`make-targets.md`'s "Runner targets" table was missing `runner-diagnostics` entirely**, even
  though `runner-protocol.md`'s Diagnostics (R-06) section already described its required behaviour
  — a real, pre-existing documentation gap (a closed list with only two of its three real entries is
  the same failure as having none, AGENTS.md). Added the row, matching R-06's own wording, so the
  two documents agree.

Pasted output from a real, hand-run `make runner-diagnostics` against a live, locally-spawned
runner pointed at an unreachable control plane (`http://127.0.0.1:1`), confirming the mechanism end
to end beyond the automated e2e test:

```json
{
  "generatedAt": "2026-09-30T13:37:14.784Z",
  "versions": { "imageVersion": "0.9.9-smoke", "protocolVersion": 1 },
  "capabilities": [],
  "configuration": {
    "LOG_LEVEL": "set", "RUNNER_CONTROL_PLANE_URL": "set", "RUNNER_TENANT_ID": "set",
    "RUNNER_NAME": "set", "RUNNER_IMAGE_VERSION": "set", "RUNNER_PROTOCOL_VERSION": "default",
    "RUNNER_CAPABILITIES": "default", "RUNNER_CPU_LIMIT": "default",
    "RUNNER_MEMORY_MB_LIMIT": "default", "RUNNER_MAX_CONCURRENT_RUNS": "default",
    "RUNNER_HEARTBEAT_INTERVAL_MS": "set", "RUNNER_DIRECTIVE_SEEN_SET_SIZE": "default",
    "RUNNER_DIAGNOSTICS_DIR": "set"
  },
  "queueDepths": { "directiveSeenSet": 0 },
  "heartbeatLatencyHistogramMs": {
    "bucketsMs": [50, 100, 250, 500, 1000, 2500, 5000, 10000],
    "counts": [1, 0, 0, 0, 0, 0, 0, 0],
    "overflowCount": 0
  },
  "errorSignatures": { "network error": 1 },
  "recentExchanges": [
    { "timestamp": "2026-09-30T13:37:06.901Z", "schema": "heartbeat-request", "byteSize": 154 }
  ]
}
```

Also confirmed: with no runner running (a graceful shutdown had already removed its own pidfile),
`make runner-diagnostics` fails with `no runner pidfile at ... — is a runner running?`; against an
explicit `RUNNER_PID` naming a process that does not exist, it fails with `no running process at
pid ... — is the runner still running?`. Neither hangs or fabricates output.

(The pasted bundle above predates the review round below — it has no `processNonce` field, since
that field did not exist yet at the time it was captured. See the fresh pasted output below for
the current shape.)

### T048 review round — pidfile identity, one authority for its paths, real script e2e coverage

Two independent reviews of the commit above converged on the same core finding from different
angles. Both fixed, plus two cheap items found in the same pass.

- **Real safety issue, fixed: pidfile identity was never verified — a recycled pid could make
  `make runner-diagnostics` send `SIGUSR2` to, and likely kill, an unrelated live process.**
  `checkProcessLiveness`/`isProcessAlive`'s old shape only proved *some* process existed at a pid,
  never that it was the runner a pidfile named. `main.ts` has no crash-path cleanup —
  `removePidFileBestEffort` only runs inside the graceful `SIGTERM`/`SIGINT` `close()` path — so a
  hard kill (`SIGKILL`, OOM, an uncaught exception) leaves a stale pidfile behind. On a long-lived
  host, once that pid is reused by an unrelated live process, the old code would find it "alive" and
  send `SIGUSR2` — whose default disposition, with no handler installed, is termination. Fixed with
  a random per-process nonce (`crypto.randomUUID()`, `main.ts`'s `start()`): written into the
  pidfile alongside the pid (`{pid, nonce}`, not a bare integer) and echoed into every dump's own
  new `processNonce` field (`packages/boundary-contract/src/diagnostics.ts`). After signalling,
  `scripts/runner-diagnostics.mjs`'s `checkDumpIdentity` compares the two and refuses to trust a
  mismatched or missing dump — a stale pidfile now reused by an unrelated process, or a signalled
  process that is not a runner at all and so times out without ever dumping, both fail loudly
  instead of silently trusting liveness alone. An explicit `--pid`/`RUNNER_PID` override has no
  pidfile-recorded nonce to compare against; `checkDumpIdentity` reports `ok` in that case since
  there is genuinely nothing to verify — the operator supplying a raw pid is asserting its identity
  themselves.
- **Also fixed in the same pass: `isProcessAlive` collapsed `ESRCH` (genuinely no such process) and
  `EPERM` (a process exists but this user cannot signal it) into one misleading "not alive".**
  Replaced with `checkProcessLiveness`, returning `{status: 'alive' | 'not-found' |
  'permission-denied'}`, with an injectable `killFn` so both branches are unit-tested directly
  without needing a real permission-denied process to probe. Both failure messages now carry the
  same Compose hint (`docker exec <container> kill -USR2 1`, reading the dump back via `docker exec
  ... cat` or a mounted volume) — the PID-namespace limitation applies to both, not just the
  not-found case. The stale comment claiming the old code "checks liveness before trusting a pid" is
  gone from `main.ts`; liveness and identity are now explicitly two different checks in both the
  code and its comments.
- **Real "closed list has one authority" violation, fixed: the pidfile/dump-file names were
  duplicated as string literals in three places** (`main.ts`, `scripts/runner-diagnostics.mjs`, the
  e2e test) — a drift between any two would silently break the real `make` target while every
  existing test stayed green, since none of them exercised the actual script as a real process.
  Fixed with a new `apps/runner/src/diagnostics-paths.ts` (`PIDFILE_NAME`, `DIAGNOSTICS_DUMP_NAME`,
  `pidFilePath()`, `diagnosticsFilePath()`) — the one authority. `main.ts` and the e2e test import it
  directly (same-package/live-TS-transform, no build dependency for either). `scripts/
  runner-diagnostics.mjs` cannot import it the same way — a static top-level import of a compiled
  monorepo package would force every unit test of this script's own pure functions to also depend
  on a prior `pnpm run build`, exactly what `vitest.config.ts`'s own workspace-package aliasing
  exists to avoid for every other package in this repo. Solved with a **dynamic** `import()` of
  `apps/runner/dist/diagnostics-paths.js`, reached only inside the real, signal-sending execution
  path (guarded by `isMainModule`) — never at module load, so `scripts/runner-diagnostics.test.ts`'s
  20 tests of the pure decision functions still need no build at all (confirmed: they pass with
  `apps/runner/dist/` entirely absent). The real execution path needing a build is not a new
  fragility — by definition, if there is a runner process for this script to signal, it was already
  built.
- **Also fixed in the same pass: the actual `make runner-diagnostics` script was never exercised
  end to end.** Only its pure decision functions were unit-tested, and the e2e test proved the
  runner's own half of the cycle by hand-sending the signal and reading the file directly — never by
  actually running `node scripts/runner-diagnostics.mjs`. Added two tests to
  `apps/runner/main-diagnostics.e2e.test.ts`: one spawns a real runner and the real script as two
  separate processes and asserts on the script's real stdout (proving the whole path — pidfile
  discovery, signalling, waiting, identity check, printing — works as shipped); the other points the
  script at a pidfile naming an implausible, certainly-unassigned pid and asserts the real process
  exits non-zero with a clear stderr message, rather than hanging or fabricating output. A genuine
  OS-level PID-reuse scenario (the actual hazard the nonce fix defends against) is not reproduced
  here — forcing a specific pid to be reused deterministically in a test is not practical — but
  `checkDumpIdentity`'s own unit tests cover the mismatch and missing-nonce branches directly with
  synthetic fixtures, and the fix itself (the nonce comparison) is exercised for real by the
  positive e2e case above (a real dump's real nonce genuinely matching its pidfile's).
- **Cheap fix: `getRunnerConfigPresence` used `Object.hasOwn(source, key)` instead of `source[key]
  !== undefined`.** For real `process.env` (every value a string, `undefined` impossible) the two
  are equivalent, but for a plain object with an explicit `{KEY: undefined}` — reachable only in a
  test fixture today — `Object.hasOwn` would wrongly report `'set'` while `loadRunnerConfig` would
  actually apply the field's default. Fixed to check the value, not mere key presence, matching
  exactly the condition zod's own `.default()` fires on.
- **Cheap fix: `make-targets.md`'s `runner-diagnostics` row didn't mention the PID-namespace
  limitation.** Added a clause matching how honestly the rest of this section already describes it.
- **Considered, not done: logging when `writePidFileBestEffort` overwrites a pidfile naming a
  different, still-live pid** (two runner instances sharing one `RUNNER_DIAGNOSTICS_DIR`) — done
  anyway, since it was cheap and directly related to the exact hazard this round fixes: a `logger
  .warn` now fires in that case, naming both pids and the path.

Fresh pasted output from a real, hand-run `make runner-diagnostics` against a live runner, after
this round's fixes — note the new `processNonce` field, and that it matches the pidfile's own
`nonce` exactly (`{"pid":76844,"nonce":"879b185f-a241-4a25-9c59-d150f123457a"}` was the pidfile's
content for this same run):

```json
{
  "generatedAt": "2026-09-30T14:06:38.622Z",
  "versions": { "imageVersion": "1.0.0-smoke2", "protocolVersion": 1 },
  "capabilities": [],
  "configuration": { "...": "unchanged shape, omitted here for brevity" },
  "queueDepths": { "directiveSeenSet": 0 },
  "heartbeatLatencyHistogramMs": {
    "bucketsMs": [50, 100, 250, 500, 1000, 2500, 5000, 10000],
    "counts": [1, 0, 0, 0, 0, 0, 0, 0],
    "overflowCount": 0
  },
  "errorSignatures": { "network error": 1 },
  "recentExchanges": [
    { "timestamp": "2026-09-30T14:06:31.572Z", "schema": "heartbeat-request", "byteSize": 156 }
  ],
  "processNonce": "879b185f-a241-4a25-9c59-d150f123457a"
}
```

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

## 001 T012 — the issue state graph has no `stale -> investigating` edge yet — resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-72

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

## 001 T024 — where does a totally-unidentifiable parse failure's "evidence" attach? — resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-73

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

**Progress is `issue_event.received_at` only. Resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-77.** Evidence recorded and audit entries written do not
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

**Resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-78 — cited evidence keeps its excerpt forever.** Detached is not purged. `data-model.md`'s
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

**Resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-74** — a signal whose fingerprint belongs to a merged issue. Merging X frees X's slot in the
unique open-fingerprint index (`merged` is excluded), and `findOpenByFingerprint` no longer finds X.
So the next signal with X's fingerprint **opens a fresh issue X′ instead of attaching to the survivor
Y** — which is exactly the duplication a merge is meant to end. Worse, unmerging X back into an _open_
state then collides with X′; that case throws `UnmergeFingerprintTakenError`, leaves the merge in
place, and is tested (a `resolved` X unmerges fine beside an open X′ — a recurrence is legal). The
real fix is a product call I did not make: route signals of a merged fingerprint to the survivor
(which changes `ingestSignal`, the counts on Y, and what an unmerge would owe X) or leave it and
accept X′. Until then a merge only hides X; it does not absorb X's future.

**Audit trail — no `audit_entry` written. Resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-76.** Same reasoning as T042: `action` must be a registered
`policy_action.action_key` and 002 does not exist. The `issue_event` (`cause = human`, `actor_ref`,
`reason`, append-only) already answers who, when and why. **Inconsistent with the T052 branch**, which
writes an audit entry with the placeholder `evidence.retention_purge`; if that stands, adding
`issue.merge` / `issue.unmerge` is one `tx.auditEntry.create` in each function in
`prisma-issue-merge.ts`. I did not want a second unregistered key in an append-only table.

**Resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-75** — the survivor's own record of the merge. The `merged` event is written on X only (the
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

## 001 T053 — tenant deletion of an issue: judgment calls, and what is not done

**Shape.** `PrismaIssueDeletionRepository.deleteIssue` (`prisma-issue-deletion.ts`, its own port
`IssueDeletionRepository` in `domain/deletion.ts`, thin command `deleteIssue`). One `withPrivilegedWrite`
transaction: lock the issue row `FOR UPDATE`, refuse if issues are still merged into it, lock its
evidence rows `FOR UPDATE`, delete everything derived, insert the tombstone, enqueue `IssueDeleted`
(payload `{ tombstoneId }`, `subjectId` the deleted id). Domain/repository/command level only; no HTTP
route, `apps/api` and `openapi.json` untouched (`contracts/openapi.yaml` already has `DELETE
/issues/{issueId}`). The bypass covers every statement of that transaction, so the callback holds only
the locks, the one refusal check, the deletes and the tombstone/outbox writes.

**Decided — the issue row is deleted, it does not move to `removed`.** `data-model.md` drew `any ──tenant
deletion──▶ removed + tombstone`, and the merged-state migration's comment assumed a removed row stays.
A `removed` row would keep the fingerprint, component and environment — derived from the customer's
errors — which is the content FR-018 says not to retain. So the row goes and the diagram now says so.
`removed` stays a state reachable by `transition()` (a legal edge; the merge fixes for it stand) that
deletion never enters. Consistency with `20260928120000_merged_state_invariant` is tested in both
directions: a merged issue with a live row deletes cleanly (the deferred trigger sees no subject and
accepts), and so does a merged-then-removed one.

**Decided, each dangling reference.**

- `issue_relationship` rows in **either direction** are deleted (`related`, `recurrence_of`,
  `merged_into`): they are derived from this issue and would point at nothing. The *other* issue keeps
  every row of its own — including an `issue_event` whose payload names the deleted id (`related`,
  and `merged`/`unmerged` events on children, if any). That is an identifier, the tombstone resolves it, and
  those tables are append-only; rewriting another issue's history is worse than a dangling id.
- **Issues merged into the deleted one: refuse** (`IssueHasMergedChildrenError`, names the children,
  nothing changed). Deleting the `merged_into` rows would leave them `merged` with no live row, which the
  database refuses to commit. Restoring them is `unmerge`, whose result depends on fingerprints that may
  have been taken since — a person's call. Cost: a deletion request against a survivor needs its
  duplicates unmerged first. A child that has since been `removed` does not count (same rule as the
  merge side). If the product wants "delete the survivor" to just work, the cheap version is to unmerge
  the children inside the deletion — not done.
- `workflow_run`, `workflow_transition`, `workflow_callback` for the issue: deleted (machine steps of a
  deleted issue). `workflow_run` has no FK to `issue`, so nothing would have failed without this. A run
  inserted for the id *after* the deletion is not refused by anything (no FK) — that is 012's writer.
- **`outbox` rows with `subject_id` = the issue: all deleted, published or not** (`IssueDetected`
  carries the fingerprint). An unpublished `IssueStateChanged` for a deleted issue would otherwise be
  delivered afterwards; a *delivered* one cannot be recalled — `IssueDeleted` is the signal, and a
  consumer that keeps a copy has to act on it (contract: consumed by "audit"). **A row a drain worker
  has claimed is not deleted underneath it** (review fix, see below): the deletion refuses instead.
- `agent_run`: **kept, `issue_id` set to null.** It is the tenant's spend (model, tokens, cost — 012's
  record, and budget accounting reads it); it holds no prompt or arguments. What stays is its tool-call
  name/digest/outcome list and `outcome`. If those count as "derived audit content", the alternative is
  deleting the run and undercounting spend — a decision for 012's owner.
- `audit_entry`: deleted where `target_id` is the issue or **one of its evidence ids** (read before the
  evidence goes). An entry about *another* issue that merely cites this issue's evidence in
  `evidence_ids` **stays** (tested): it is that issue's audit and a `related` decision could legitimately
  cite it; the ids are identifiers. A retention-purge entry (`evidence.retention_purge`, target the
  evidence id, "id and fact only") for evidence purged *before* the deletion also stays — nothing links
  it to the issue any more. Entries whose `target_id` is a future conclusion of the issue (a diagnosis
  id) are **not** found; whoever adds those tables must add them to the deletion (see the next item).
- **A closed list with a reader.** `ISSUE_ID_COLUMNS` names every column in the database called
  `issue_id`/`other_issue_id` that the deletion handles; a test compares it with `information_schema`,
  so 006's diagnosis table (or anyone's) fails it until `prisma-issue-deletion.ts` deals with it. It
  cannot see a table that refers to the issue without such a column (`evidence_link`, `audit_entry`,
  `outbox`, a conclusion cited via `evidence_link.conclusion_id`): those are in the code by name.

**Decided — the tombstone is the audit record; no `audit_entry` is written for the deletion.** R-03
says the privileged path is itself audited, and `evidence.retention_purge` writes an entry. Here the
tombstone is that record: it lives in the `audit` schema, says who/when/why, and is now immutable. A
fresh `audit_entry` targeting the deleted id would make an audit read for that id return something,
contradicting "audit content gone"; targeting the tombstone id instead would just duplicate it. Either
way the action key (`issue.delete`) would be a third unregistered placeholder next to `issue.close` and
`evidence.retention_purge` — 002's `policy_action` list still does not exist. Same open gap as the
index item 5; decide once for all three.

**Decided — the tombstone table now has teeth (migration `20260929000000`, with `down.sql`).** It was
neither immutable nor unique. Added: unique `(tenant_id, target_type, target_id)` (tenant-leading; the
old `(tenant_id, deleted_at)` index stays), `CHECK`s on `requested_by` (1-128) and `reason` (1-500, not
blank), and triggers rejecting `UPDATE`/`DELETE`/`TRUNCATE` that **do not honour
`healer.privileged_write`** — that flag covers the whole deletion transaction, and a tombstone the
deleting path could rewrite proves nothing. Nothing may delete a tombstone; tenant offboarding would
need its own migration and decision. `down.sql` is exercised (applied, checked, re-applied). Table was
empty (no prior writer), so the constraints install without a data check. `reason` and `requested_by`
are the requester's own words and the only way text could be smuggled into a tombstone; bounded, not
sanitised — a requester who pastes a log line into `reason` has put it there. `requested_by` is a
caller-asserted actor string, the `X-Actor-Id` trust level.

**Decided — idempotency and races.** A deleted issue is found by `(tenant, 'issue', id)` in the
tombstone after the row lock finds no row: a repeat, or the loser of two concurrent requests, gets
`already_deleted` with the winner's tombstone and writes nothing (its reason/requester are dropped — the
first request is the record). Another tenant's issue, a missing id and a malformed one are the same
`NotFoundError('Issue')`; another tenant asking after the owner deleted it also gets not-found (the
tombstone lookup is tenant-scoped). Row locks, held-open transactions and `pg_stat_activity` polling
(no sleeps) for: two concurrent deletions; a signal mid-commit; evidence mid-commit (a share of the issue
row); an **uncommitted evidence link** (this is why the evidence rows are locked `FOR UPDATE` — without
it the `DELETE` waits for the link's foreign-key lock, the link commits and the delete fails on the
FK); a transition mid-commit; a merge queued before / after the deletion; a retention purge queued
before / after. Deterministic outcomes are asserted, e.g. deletion-first makes the merge
`NotFoundError` and leaves the would-be child untouched. A deadlock with an outside transaction
(forced: it holds the evidence rows and reaches for the issue row) surfaces as
`ConcurrentModificationError` (review fix: this scenario is now tested). Since the review, every
`waitForBlocked` names the holder it waits behind (its backend pid) and counts only waiters that began
after that holder's transaction — a waiter leaked by an earlier test no longer satisfies it.

**Mutation-checked, first round** (production code broken, specific test seen failing, restored byte-for-byte):
no `FOR UPDATE` on the issue row (4 race tests); none on the evidence rows (the uncommitted-link test);
merged-children check; lock without `tenant_id`; no UUID check; each of outbox, agent-run, reverse
relationship, tombstone-lookup and the audit-before-evidence order; three deletes made wider than the
issue (events, outbox, audit); the correlation check; `set_config(..., false)` in
`withPrivilegedWrite` (my leak test, on a `connection_limit=1` client, fails — the target is uncited
evidence, so a leak would really delete it); each trigger, the bypass-honouring variant, the unique
index and the `CHECK`s in the migration; `>` to `>=` and the NUL clause in `checkDeletionRequest`.
**Not separately testable:** the `tenant_id` predicate on the individual `DELETE` statements — ids are
globally unique primary keys, so removing it changes no outcome; it is defence in depth (the same
finding as T052's `NOT EXISTS` — **superseded by the review round below**, where the FK-less tables'
predicates are proved). The first version of the implementation was written before the e2e file
(test-after, then mutation-checked), not red-green.

**Open / not done.**
- No HTTP route (`DELETE /issues/{issueId}`, its `Idempotency-Key`, its tenant-isolation e2e test,
  `openapi.json`); nothing calls `deleteIssue` in production. `findTombstone` (review fix, below) is the
  domain-level reader of R-12's record, but no route or view calls it either: "a silent gap is never
  mistaken for data loss" still needs the route (answering from the tombstone) to be true for a caller.
- Tenant-level deletion ("tenant deletion" as in offboarding a whole tenant) is not this; it removes one
  issue per call, so a whole-tenant erasure is a loop over issues plus tables that have no issue
  (`ingestion_delivery`, provider config) — unbuilt.
- Signals for the deleted fingerprint open a *new* issue afterwards (the fingerprint slot is free);
  nothing remembers "this tenant asked to forget it".
- Machine copies outside Postgres are out of scope: BullMQ jobs still holding a signal, the broker's
  delivered events, backups (the backup runbook does not say how deleted tenants age out).
- `VERSION` and `docs/changelog.md` not bumped (parallel branches conflict on them).
- The `actor` on a deleted issue's `state_changed` events etc. is gone with them; the tombstone's
  `requested_by` is the only person named.

## Review round on T053 (commit amended) — what changed, and what is recorded rather than built

**1. Links of a merge survivor (FR-009) — decided: refuse.** Deleting issue A used to delete every
`evidence_link` whose evidence belongs to A, whoever's conclusion made it. Nothing ties a link's
`conclusion_id` to an issue and the conclusion tables do not exist, so the deletion cannot tell. The one
v1 situation in which another issue legitimately cites A's evidence is a merge (the survivor's diagnosis
cites the merged child), so `deleteIssue` now refuses a `merged` issue (`IssueMergedIntoAnotherError`,
names the survivor, nothing changed): unmerge first. Tested: the survivor's link survives the refusal;
after `unmerge` the deletion goes through; a non-merged issue still deletes its own links.
**Exception, on purpose:** an issue merged and then `removed` keeps its live `merged_into` row but
`unmerge` refuses it (typed error), so refusing its deletion too would leave it undeletable for good.
It is deleted, and a survivor conclusion that cited its evidence loses that link — the same residual as
below. **Open (unknowable now):** a link from a conclusion we cannot attribute (any future conclusion
table, 006+) to this issue's evidence is deleted with it, and with it that conclusion's FR-009 support.
When the conclusion tables exist the deletion should refuse (or re-home) links whose conclusion belongs
to another issue; `data-model.md` now says exactly this.

**2. Timeouts — decided: a typed error, and the lock wait is what is bounded.** `withPrivilegedWrite`
takes an optional `{ maxWait, timeout }` (passed to `$transaction`; T052's call sites are unchanged and
their tests pass). Finding while writing the test: **Prisma's `timeout` does not cut a statement that is
blocked on a lock short** — the rollback queues behind the blocked statement, the promise hangs until the
holder lets go, and only then P2028. So the deletion sets `lock_timeout` (default 30 s) as the first
statement of its transaction (a bounded wait -> SQLSTATE 55P03) and passes `timeout` 120 s / `maxWait`
30 s; `55P03` and `P2028` both become `DeletionTimedOutError` (nothing changed, the caller must raise the
bound — a retry of a too-big issue fails identically), everything else goes through
`translateConcurrencyError` as before (deadlock and serialisation failures stay
`ConcurrentModificationError`). `transition()`/merge still map P2028 to "concurrent"; I did not show that
wrong for them (their transactions are short and retried by design), so it is unchanged. All three
bounds are constructor options; the values are placeholders.

**3. A claimed outbox row — decided: refuse, and let the drain survive a vanished row.** (a) The
deletion locks the issue's unpublished outbox rows `FOR UPDATE` (the drain claims with `SKIP LOCKED`, so
it can no longer claim what we hold, and a claim still being committed is waited for) and refuses with
`IssueEventsInFlightError` (retry shortly, nothing changed) if any is claimed inside the drain's own
claim window. That window is read from the drain's constant, now exported (`CLAIM_TIMEOUT_SQL`,
`packages/events`), not copied. A claim older than the window and a row already published do not
block (`markPublished` leaves `claimed_at` set, so the published check matters). (b) `drain()` treats
`OutboxRowGoneError` (thrown by `PrismaOutboxStore.markPublished`/`recordFailure` on P2025) as "row gone,
not batch failed": counted in a new `DrainResult.vanished`, batch continues, any other store error still
aborts. `DrainResult` gained a field, so the two existing `toEqual` assertions in `outbox.test.ts` were
updated deliberately. Both halves were watched failing before they were fixed.

**4. Integrity.** The final `DELETE FROM issue` must remove exactly one row (`DeletionIntegrityError
'issue_not_deleted'`, transaction rolled back — tested with a `BEFORE DELETE` trigger that swallows it);
a tombstone that already exists for a live issue (23505) is `DeletionIntegrityError
'tombstone_for_live_issue'` instead of a raw P2002. The repository validates `requestedBy`/`reason`
itself (`checkDeletionRequest`, before anything is locked — tested on a raw call with the row locked so
that a call reaching the lock would hang); the command still checks too.

**5. Reader.** `findTombstone(where)` on the deletion port and repository (a `findFirst` scoped by
tenant, `null` for another tenant's, an unknown or a malformed id). About 10 lines. **No HTTP route in
this batch**, as before.

**6. Comments.** `tenantDigest` no longer claims "every table" by hand: tables come from
`information_schema` (as does the new whole-database scan). **The comment in migration
`20260928120000_merged_state_invariant` — "tenant deletion may remove a merged issue, and its row stays
as it was" — is stale**: deletion deletes the issue row and its `merged_into` row (and now refuses a
`merged` issue). The migration is committed and cannot be edited (`prisma-migrations.md`); the
invariant (B) it describes (`removed` with a live row) is unaffected.

**7-9, 11. Tests that proved less than claimed.** "Nothing survives" is now read from the catalogue:
after a deletion, every base table is scanned for any row whose text mentions the issue's id, its
evidence ids, its run id, or any of six content strings (fingerprint, excerpt, source ref, label,
payload marker, component id) and the only hits are the tombstone and the `IssueDeleted` row. The
fixture also has another issue's conclusion citing the deleted issue's evidence and a `workflow_run`
with an `awaiting` payload. `survivors()`/`tenantDigest()` are derived from `information_schema`
(`EXCLUDED_TABLES` is the one place to skip a table, currently empty). The `tenant_id` predicate of
every FK-less table is now proved by planting another tenant's rows that carry the same ids
(`audit_entry` both target kinds, `outbox`, `workflow_run` + step + callback, `agent_run`) and
breaking each predicate: `audit`, `outbox`, `workflow_run`, `agent_run`, and the callback and
transition subqueries each fail the test. Also mutation-checked, each watched failing then restored
byte-for-byte: the merged-into refusal, `lock_timeout`, both timeout mappings, the `timeout` pass-through,
the in-flight check, its `FOR UPDATE`, its window and its `published_at` filter, the one-row check, the
23505 mapping, the repository validation, `findTombstone`'s tenant scope and id check, and skipping a
table (the whole-database scan fails). New scenarios: timeout, deadlock, claimed outbox (three
variants), 23505, raw-call validation, `findTombstone`. Red first this time: the new e2e tests were
run against the pre-fix code (the ones for behaviour that already worked — a stale claim, the deadlock
mapping — passed and are regression cover, not red).

**Recorded, not built.**
- (a) `workflow_run.issue_id` and `agent_run.issue_id` have no foreign key and no lock on the issue, so a
  row inserted concurrently with or after the deletion keeps the deleted id and is never removed.
  Latent — no production code creates runs yet — and the `information_schema` test compares column
  names, it cannot see orphaned rows. `agent_run` is named here as well as `workflow_run`.
- (b) Retention-purge `audit_entry` rows for evidence purged before the deletion survive (target =
  evidence id, constant reason); `audit_entry.reason` is free text in general; `agent_run.correlation_id`
  is kept and links surviving rows and already-delivered events to the deleted issue's work.
- (c) The `removed` state is now effectively dead — **resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-79: drop it from the graph.**
- (d) Refusing to delete a survivor with merged children, and (new) an issue that is itself merged —
  **resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-80: refuse, require explicit unmerge first.**
- (e) Delivered outbox events, BullMQ jobs still holding a signal, and backups cannot be recalled.

## Decisions waiting on Pavlo — phase 8 integration (index; the detail is in the named sections)

Nothing below blocks the work already done; each has a default in place and a cost if the default is
wrong. Ordered by how much a wrong default costs.

1. **Resolved 2026-10-02 — [decisions.md](docs/decisions.md) C-74, C-75.** A merge hides an issue but does not absorb its future signals. (`001 T049/T050`.)
2. **Resolved 2026-10-02 — [decisions.md](docs/decisions.md) C-78.** Cited evidence keeps its excerpt forever. (`001 T052`.)
3. **Resolved 2026-10-02 — [decisions.md](docs/decisions.md) C-72.** A signal on a `stale` issue does not un-stale it. (`001 T051`.)
4. **Resolved 2026-10-02 — [decisions.md](docs/decisions.md) C-90** (elevated to its own tracked item, not re-deferred piecemeal). Nothing schedules the staleness sweep or evidence retention. (`001 T051`, `001 T052`.)
5. **Partially resolved 2026-10-02 — [decisions.md](docs/decisions.md) C-76** closes the merge/unmerge half (writes an unregistered-key `audit_entry`, same tradeoff as close/purge). `issue.close`/`evidence.retention_purge` registration against 002's real `policy_action` list is still open — left as-is on purpose (see 2026-10-02 walkthrough item 6): routing 001's mutating actions through the policy gate is bigger than registering a key, not decided here.
6. **Resolved 2026-10-02 — [decisions.md](docs/decisions.md) C-81: no separate ADR needed**, ADR 0012 already covers it. (`001 T057`.)
7. **The human actor is a caller-asserted `X-Actor-Id` header** (free-form, can be `system` or
   `ingestion`), the same trust level as `X-Tenant-Id`: the auth layer carries only a tenant id.
   Real identity needs authentication, which does not exist. (`001 T057`.)
8. **`Idempotency-Key` is validated but not stored**, so "same key, different body -> 409" from the
   contract is not implemented; close is idempotent by state instead. A key table is a new pattern.
   (`001 T057`.)
9. **The 12 000-signal replay test timed out in a full `make ci`; the cause was mostly the suite's
   own parallelism, and the four heaviest e2e files now run alone** (`HEAVY_E2E` in
   `vitest.config.ts`). Measured: alone it takes ~55 s (34 s on a quiet machine, 2.8 ms a signal);
   vitest ran 7 workers over 29 files with 8-10 Postgres containers at once; all 12 000 signals
   update one issue row, so its row lock serialises them and 25 "concurrent" writers behave as one.
   Failed 4 of 4 full runs before, passed 4 of 4 after (43-91 s). Its `CONCURRENCY` went 25 -> 5 —
   less stress on the lock, but a mutation making the counter non-atomic still fails it (2406 vs
   12000). **Still open:** (a) the wall time of the whole suite grew (263-292 s -> 283-381 s);
   (b) 'two concurrent transitions from the same state' and the merge race cases fail when run in
   parallel with other files — they assume two calls overlap, not investigated; (c) the 120 s budget
   is a guess, not a requirement (SC-001 has no time bound; plan.md allows 5 000 signals/min); (d)
   `recordOccurrence` does ~7 round trips per signal with the row locked for 4 of them — folding the
   SELECT and event INSERT into one statement would cut the lock hold 3-4x, a source change for the
   owner of ingestion, not made here.
10. **Confirmed 2026-10-02 — [decisions.md](docs/decisions.md) C-80.** Deleting a survivor, or an issue that is itself merged, is refused, and a deletion writes no
    `audit_entry` (the immutable tombstone is the record). Cheap alternatives: unmerge inside the
    deletion; an entry targeting the tombstone id (the fourth answer to item 5). A link from a conclusion
    the deletion cannot attribute to an issue is deleted with the evidence — unknowable until 006's
    tables exist. `findTombstone` exists; no route calls it. (`001 T053`.)
11. **Publishing this work.** Everything for T045-T057 except T056 sits on the local branch
    `worktree-001-phase8-staleness` (plus the two agent branches it merged), unpushed by instruction.
    Squash or keep the history, and when to run a full green `make ci` first, are yours to call.
12. **Retention by received time (R-10) is a claim, not a mechanism.** `expires_at` is whatever the
    caller passes to `recordEvidence`; nothing derives it from `received_at` (retention.ts's comment
    says it is), and signals (`issue_event`) have no retention at all. Needs: where the retention
    period lives (per tenant?) and whether signals expire. Blocks quickstart 7, so T056.
    (`001 T056`.)
13. **A parse failure is not recorded as evidence** (quickstart 20). `evidence.issue_id` is NOT NULL
    and an unparseable signal has no issue; today the `rejected` array in the 202 response is the
    only record. Junk-drawer issue, a new evidence type, or reword the scenario. Blocks T056.
    (`001 T024`.)
14. **No registry or hosting is provisioned for the runner image.** `make runner-build` stops at a
    local tagged image plus a stamped version/digest file; pushing it anywhere, and publishing a
    customer-facing changelog entry, are manual steps with no target yet. Revisit once a registry
    exists. (`012 phase 6`, [ADR 0014](docs/adr/0014-runner-artifact-build-and-versioning.md).)

## 001 T056 — quickstart run

Run 2026-09-28 on `208cd73`, every file below executed (heavy files alone under their own project:
`e2e-heavy-1` 40 s, `-3` 6 s, `-4` 33 s; the shared e2e group 14 files / 158 tests in 110 s; 14 unit
files). All green. **24 PASS, 2 PARTIAL, 1 NOT IMPLEMENTABLE YET** — T056 stays unticked.

| # | Scenario | Status | Test | Note |
|---|----------|--------|------|------|
| 1 | Burst collapses | PASS | `ingest-signal.e2e.test.ts`::replaying 12 000 signals … (quickstart 1) | count, first/last seen, one row; 34.7 s alone |
| 2 | Volatile parts ignored | PASS | `fingerprint.test.ts`::is identical for the same failure with different request ids, addresses and line offsets | also exercised at 12 000 scale in #1 |
| 3 | Different failures | PASS | `fingerprint.test.ts`::differs for a genuinely different exception type …; `ingest-signal.e2e.test.ts`::a genuinely different exception type creates a separate issue … | |
| 4 | Delivery retry | PASS | `apps/api/ingest.e2e.test.ts`::the same delivery posted twice returns duplicate: true … | nothing enqueued the second time |
| 5 | Reopen | PASS | `ingest-signal.e2e.test.ts`::… inside the reopen window, reopens it … | |
| 6 | Recurrence | PASS | `ingest-signal.e2e.test.ts`::… outside the reopen window, creates a new issue linked recurrence_of … | rule `reopen_window_exceeded` on the row |
| 7 | Clock skew | **PARTIAL** | `ingest-signal.e2e.test.ts`::a signal with a clock five minutes ahead …; `timeline.e2e.test.ts`::orders by observed time … | ordering by observed: proven. Retention by received: **not implemented** — see finding 1 |
| 8 | Evidence immutable | PASS | `append-only.e2e.test.ts`::rejects an UPDATE that changes anything but evidence.ref_state | raw SQL, i.e. at the database |
| 9 | Conclusion without evidence | PASS | `evidence-link-repository.e2e.test.ts`::rejects a conclusion with no evidence_link …; `evidence-required.test.ts` (message `EVIDENCE_REQUIRED`) | the guard; no diagnosis table exists until 006 |
| 10 | Producer attribution | PASS | `step-attribution.e2e.test.ts`::rejects a link attributed to a step other than the one executing | `STEP_ATTRIBUTION_MISMATCH` |
| 11 | No retrospective links | PASS | `no-retrospective-link-api.test.ts` | contract review, as the scenario says |
| 12 | Detachment | PASS | `evidence-repository.e2e.test.ts`::detaching evidence leaves every conclusion built on it intact; `issue-close-and-views.e2e.test.ts` (quickstart 16) shows `refState: detached` in the graph | "delete the source log range" is modelled as `detach`; nothing detects source loss yet |
| 13 | Oversized excerpt | PASS | `evidence-repository.e2e.test.ts`::a 40 MB excerpt is bounded at capture … | through `recordEvidence`, not HTTP (the ingest body limit is 5 MB, and a dump is evidence, not a signal) |
| 14 | Timeline determinism | PASS | `timeline.e2e.test.ts`::renders byte-identical output twice …; `issue-close-and-views.e2e.test.ts`::renders byte-identical timeline and graph across separate requests | |
| 15 | Timeline has no model | PASS | `timeline.e2e.test.ts`::unions domain facts, machine steps and evidence …; **new** `timeline-no-model.test.ts` | no-model half had no test; added |
| 16 | Views agree | PASS | `issue-close-and-views.e2e.test.ts`::timeline, evidence graph and audit for one issue contain the same facts (quickstart 16) | |
| 17 | Merge | PASS | `issue-merge.e2e.test.ts`::records a merged_into row, the merge event …; ::does not copy or move any evidence row … | repository level; no `/merge` route (finding 3) |
| 18 | Unmerge | PASS | `issue-merge.e2e.test.ts`::counts on both sides are what they were, never split (R-08); ::sets removed_at … | repository level; no `/unmerge` route |
| 19 | Stale | PASS | `stale-issues.e2e.test.ts`::marks an idle issue stale …; ::never resolves anything …; `worker.e2e.test.ts`::a staleness-sweep job … | nothing schedules the sweep (index item 4) |
| 20 | Malformed payload | **PARTIAL** | `apps/api/ingest.e2e.test.ts`::a batch mixing valid and malformed signals …; ::a wrongly typed but non-identity errorSignature field is dropped … | issue from what parsed, nothing silent: proven. "Parse failure recorded as evidence": **not implemented** — finding 2 |
| 21 | Downstream failure | PASS | **new** `worker.e2e.test.ts`::a signal whose downstream keeps failing is retained, retried … (quickstart 21); ::a job that can never succeed becomes an observable dead letter … | before: dead letter only, with `attempts: 1`, so retry was never exercised |
| 22 | Tenant isolation | PASS | `apps/api/issues.e2e.test.ts` (issue, evidence, audit: 404s another tenant's issue — never 403); `issue-close-and-views.e2e.test.ts` (timeline, graph, close) | `assertTenantIsolated` expects 404 exactly |
| 23 | Deletion | PASS | `issue-deletion.e2e.test.ts`::leaves no row of the issue in any table …; ::holds the identifier, time and requester — and no field derived … | repository level; no `DELETE /issues/{id}` route, so a tenant cannot ask yet (finding 3) |
| 24 | Resolved means verified | PASS | `issue-resolved.test.ts`::IssueResolved has exactly one producer (6 tests); `issue-resolved.e2e.test.ts`::no other transition publishes it … | |
| 25 | Knowledge drift terminates | PASS | `state-machine.test.ts`::knowledge_drift terminates at human adjudication (5); `issue-repository.e2e.test.ts`::a knowledge_drift issue cannot enter acting … | "never enters reproduction": no reproduction step exists — 007 must honour it |
| 26 | Correlation, not merge | NOT IMPLEMENTABLE YET | `issue-repository.e2e.test.ts`::correlate records a related relationship …; `correlate-issue.test.ts`; `correlation.test.ts` | rule, row, `IssueRelated`, states unchanged: proven at repository level. End to end ("ingest … sharing component") needs **004**: ingestion leaves `componentId` null and `correlateIssue` has no caller |
| 27 | Human close | PASS | `issue-close-and-views.e2e.test.ts`::resolves the issue as self_resolved, with no verification evidence … | "a held 009 ticket escalates": NOT IMPLEMENTABLE YET, needs **009** |

**Findings** (no product code changed):

1. **R-10 retention is unenforced** (#7). `recordEvidence` stores the caller's absolute `expiresAt`.
   Failing case: record evidence with `observedAt = now + 5 min` and `expiresAt = observedAt + 30 d` —
   accepted as-is, so a skewed source clock moves the expiry, exactly what R-10 forbids. Nothing in
   001 computes `expires_at`, and `issue_event` has no retention at all. Index item 12.
2. **Parse failures are not evidence** (#20) — the open T024 question, now blocking T056. Index item 13.
3. **Three contract routes have no task and no code**: `DELETE /issues/{issueId}`, `POST
   /issues/{issueId}/merge`, `POST /issues/{issueId}/unmerge` (`contracts/openapi.yaml`). The
   behaviour behind them is built and tested; a tenant cannot reach it. Already noted as "not done"
   under T049/T050 and T053; recorded here because no task in `tasks.md` owns it.

**Tests added** (each passed, then was watched failing against a temporary break, restored byte for
byte): `worker.e2e.test.ts` quickstart 21 — ingestion `attempts: 5 -> 1` made it fail (`waitFor timed
out`); `timeline-no-model.test.ts` — adding `@healer/llm` to `@healer/events`' dependencies (a
transitive dependency of `@healer/domain-issues`) made it fail.

## 002 T006–T013 — domain core: judgment calls (under independent review as of this writing)

Five calls the implementer flagged in the hand-back for `packages/domain/policy/src/domain/**`
(the pure evaluator — 489 tests, 95% coverage floor met). None block progress; recording the
reasoning now, will amend below once both independent reviews (code-reviewer,
silent-failure-hunter) land, in case either surfaces a real defect rather than a style question.

1. **The DENY-seed fold, read literally, would force every decision to DENY.** research.md R-04:
   "folds the matched outcomes with `max`, seeded with `DENY`." `DENY` is the lattice's top
   element, so threading it through every reduce step (`max(DENY, x) = DENY` always) can't be the
   intended algorithm — quickstart 6 needs a genuine allow/deny conflict to resolve to `DENY`
   *because they conflict*, not unconditionally. Implemented as: empty matched-rule set → `DENY`
   (`NO_MATCHING_RULE`, FR-005); non-empty set → real `max` over the matched outcomes only, no
   `DENY` injected. This matches every quickstart scenario (1, 4, 5, 6) and FR-002/005/006.
   **Ruling: correct reading of an ambiguous sentence — "seeded with DENY" describes the fold's
   identity element for the empty case, not a literal extra list member.** Cost if wrong: every
   decision would need to actually always be DENY, which contradicts the spec's own worked
   examples, so this is very unlikely to be the intended meaning.
2. **`ceilingApplied` is true only when the clamp changes the outcome**, not whenever
   `grantLevel > ceiling`. Quickstart 9 wants `ceilingApplied = true` when a hand-written
   over-ceiling grant is refused — need to confirm the test for that scenario exercises the real
   distinction (clamp *binding* vs. clamp merely present) rather than a case where both readings
   happen to agree. Under review now.
3. **Invented `cooldownBounds` shape** on `ResolvedRuleset`, since `contracts/evaluation.md`'s
   `DecisionInput.cooldown` group carries only counts (`recentAllowCount`/`windowSeconds`/
   `attemptCount`), not bounds — the bounds live in `policy.action_limit` (T054, a later phase,
   not built yet). This is the least-certain call in the batch: T054's real repository may shape
   the bounds differently than what was guessed here. Under review now; likely needs revisiting
   when T054 lands regardless of what this review finds.
4. **`ImpactClosure` defined locally** as `{ memberIds: readonly string[]; maxDepth: number }`
   since spec 004 hasn't landed in this repo — scoped to exactly what the four antitone closure
   operators need. Placeholder, to be replaced by 004's real type when it exists.
5. Quantity predicates (`atLeast`/`atMost`) don't enforce "same group only" comparison at runtime
   (contracts/evaluation.md: "compared against a literal or against another field in the same
   group, never against a computed expression") — deferred to publish-time validation (T019),
   out of scope for the pure evaluator itself.

Not added to "Decisions waiting on Pavlo" — none of these need a decision only Pavlo can make;
they're implementation judgment calls on ambiguous spec prose, and two independent reviews are
actively checking them against the actual test suite before this batch is called done.

## 002 T032/T033 — text requires Phase 4/6 functionality that doesn't exist yet in this run's scope

This run covers Phases 1–3 (T001–T033) only. Two of Phase 3's own tasks, read literally, need
functionality from later phases that are out of scope here:

- **T032** ("e2e isolation matrix: rule set, grant, decision, approval and budget reads all return
  404 for another tenant") — `grant`, `approval` and `budget` reads don't exist yet
  (`AutonomyGrant`/`ApprovalRequest`/`BudgetLimit` endpoints are Phase 4/6/7).
- **T033** ("publish a rule set, change a budget, grant and revoke → four audit entries") — the
  grant/revoke/budget-change commands (`GrantAutonomy`, `RevokeAutonomy`, a budget-write endpoint)
  are Phase 4/6, not built here.

**Ruling:** scope both to what actually exists at the end of this run — rule set and decision reads
for T032's isolation matrix, `PublishRuleset`'s single audit entry for T033 (already proven by
batch 5's audit-wiring fix). Mark both tasks with a note in `tasks.md` that the grant/approval/
budget portions are deferred to whichever session implements Phase 4 (US2, autonomy grants) and
Phase 6 (US4, budgets) — they should extend these same tests rather than writing new ones from
scratch, per this repo's "consolidate, don't append" documentation rule. Not escalated to "Decisions
waiting on Pavlo": this is a sequencing fact (the referenced entities don't exist yet), not a design
ambiguity — building stub grant/revoke/budget commands just to satisfy today's phase-3 task text
would be doing Phase 4/6's work under a Phase 3 label, which the plan's own phase ordering (US2
"with US1", US4 "alongside US3", both after Phase 3's checkpoint) doesn't ask for.

## 002 batch 6 — `policy.policy_decision.issue_id` breaks 001's deletion-completeness gate

001's `issue-deletion.e2e.test.ts` ("handles every column in the database that names an issue")
scans the whole schema for any column literally named `issue_id`/`other_issue_id` and requires it
to appear in `packages/domain/issues/src/infrastructure/prisma-issue-deletion.ts`'s closed
`ISSUE_ID_COLUMNS` list — no exemption path exists. `policy.policy_decision.issue_id` (added in
002's batch 5, T021–T023) isn't in that list, so the gate now fails: 371/372 e2e, one real,
reachable, unexplained-by-load red.

**Ruling:** null the column, don't delete the row, following the exact precedent already set for
`agent_run.issue_id` (also a retained audit/cost record, also nulled rather than deleted on issue
erasure) — a `policy_decision` is evidentiary (FR-017: "every decision explicable a year later";
SC-001's reconciliation) and must survive its issue being erased, the same reason `agent_run`
survives. This is safe against `policy_decision`'s own append-only trigger (which normally rejects
any column but `consumed_at`/`invalidated_reason`) because the whole deletion transaction already
runs under `withPrivilegedWrite`, the same bypass `agent_run`'s nulling already relies on — nothing
new to build there, just one more statement inside the existing privileged transaction and one more
entry in the closed list. Fixing this in-run (folded into batch 7) rather than deferring: it's the
thing currently keeping the full e2e suite from being green, the fix is mechanical and
precedent-following (not a new design decision), and 002 is what broke the gate.

## 002 batch 7 — two spec-vs-code disagreements found while wiring the HTTP surface — item 1 resolved 2026-10-02 ([decisions.md](docs/decisions.md) C-83), item 2 still open (waits on Phases 5-7)

Per AGENTS.md ("if a document and the code disagree, say so and ask which is stale") — both
independently confirmed by review, not fixed in code this run:

1. **`RULESET_INVALID` has no seat in the closed error-code list.** `contracts/evaluation.md`'s
   "Error codes" section names it as a first-class sibling of `CEILING_EXCEEDED`,
   `DECISION_ALREADY_CONSUMED`, etc. — all of which already exist in
   `packages/shared/src/errors/index.ts`'s `ERROR_CODES`, except this one. `POST /policy/rulesets`
   maps a schema-invalid rule set to the existing generic `VALIDATION` code instead, matching this
   repo's actual precedent (every other DTO `safeParse` failure in `apps/api` does the same, and
   there's no existing precedent anywhere for a domain-specific 422 code distinct from
   `VALIDATION`). Reads as a scaffolding gap this batch was first to hit, not a deliberate spec
   choice. Not fixed: adding a new closed-list error code is a small but real decision (does a
   caller actually need to distinguish "rule set schema-invalid" from "some other validation
   failure"?) that's cheap to make later and costs nothing to defer — `VALIDATION` is correct today.
2. **`contracts/openapi.yaml`'s `DecisionInput` schema and the domain's real, closed
   `decisionInputSchema` (batch 3) are substantially different shapes** — the yaml is flat with
   mostly-nullable fields; the real schema is nested (`action.actionClass`, required
   `reversibility`/`autonomy`/`budget` groups the yaml doesn't have at all). Confirmed via the
   yaml's own header: it's an explicitly-labeled *draft*, and per ADR 0012 the generated
   `apps/api/openapi.json` is the authoritative, drift-checked contract — `contracts-check`
   diffs the generated document against the committed one, never touches the hand-written yaml, so
   nothing keeps the two in sync mechanically. `POST /policy/dry-run` validates against the real
   domain schema (correct — it's what the evaluator actually accepts), which is why the two
   disagree.

**Ruling**: log both here rather than editing `contracts/evaluation.md`/`openapi.yaml` in this
run — reconciling a spec doc against a shape that's still evolving (Phase 4-7 will add fields to
`DecisionInput` too, e.g. real `autonomy`/`budget` resolution) is better done once, after those
phases land, than incrementally per-batch. Whoever does that pass should start from this entry and
from `decisionInputSchema`'s actual code, not from the yaml.

## 002 — final whole-branch review: three spec deviations never formally logged — all three resolved 2026-10-02 ([decisions.md](docs/decisions.md) C-84, C-85, C-86 — item 1's original prediction turned out wrong, see C-86)

Surfaced by the final review across the whole T001–T033 diff; each was mentioned in a batch
hand-back but never got its own QUESTIONS.md entry — recording now per AGENTS.md ("if a document
and the code disagree, say so and ask which is stale").

1. **`policy_decision` isn't bound to `autonomyEpoch`.** T021 and `contracts/evaluation.md` both
   name the epoch as one of five things a decision binds to (`workflowRunId`, `workflowState`,
   `proposalDigest`, `rulesetVersion`, `autonomyEpoch`); `data-model.md`'s own `policy_decision`
   field list has no epoch column. Batch 5's ruling (read the tenant's epoch, return it in the
   result, don't persist it) stands — nothing in this run's scope (T001–T033) needs the epoch
   pinned to the row; Phase 4 (revocation, the epoch's actual purpose) will need to add the column
   deliberately alongside the grant/revoke mechanism.
2. **A digest mismatch doesn't invalidate the decision** — `consumeDecision` refuses execution
   (`DIGEST_MISMATCH`) but leaves `invalidated_reason` null and the row otherwise untouched, so a
   second attempt with the correct digest could still succeed. `data-model.md`'s state-transition
   diagram shows `issued ──digest mismatch──▶ invalidated` as a terminal transition. Pinned by an
   existing e2e test (`policy-decision-repository.e2e.test.ts`), so this is the code's actual,
   deliberate behavior, not an oversight — but the diagram says otherwise and nobody decided which
   is right. Open: does a digest mismatch mean "wrong attempt, try again with what you actually
   meant to execute" (current code) or "this decision is now burned, re-evaluate from scratch"
   (the diagram)? Needs a decision before Phase 4/8/10 build real executors against this contract.
3. **Decisions write no `audit_entry`.** FR-017 says every decision goes to the audit trail;
   `PolicyDecisionRecorded` is the outbox event the contract names as "001 (audit link)" — nothing
   in this run consumes that event or writes an audit row for a plain evaluate-and-bind. Ruling so
   far (undocumented until now): a `policy_decision` row IS itself the auditable record — it's
   append-only, immutable, and already carries actor-equivalent context (the caller, the ruleset
   version, the trace) — a *separate* `audit_entry` would duplicate it. Worth confirming this
   reading is actually what FR-017 means, since "written to the audit trail" could mean
   `audit_entry` specifically, not "is itself an audit-grade record."

Not elevated to "Decisions waiting on Pavlo" yet — (1) is settled (Phase 4's problem), (2) and (3)
are real open questions but don't block T001-T033's own scope; flagging here so whoever builds
Phase 4/8/10 sees them before assuming either reading.

## 002 — forward risk for Phase 5: `cooldownBounds` has no versioning, replay may not reproduce it — resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-82

Batch 3 invented a `cooldownBounds` shape on `ResolvedRuleset` ahead of T054 (`action_limit`,
Phase 5). `action_limit` as specified in `data-model.md` is a plain mutable table — no version
column, no append-only guarantee. `check:decision-replay`/`replayDecision` (batch 7) re-run
`evaluate()` against a decision's stored `decision_input` and historical `ruleset_version` and
expect the same outcome forever (FR-002) — but if cooldown bounds are read live from a mutable
`action_limit` at replay time rather than from something versioned, a decision whose outcome
depended on a cooldown/rate-limit predicate cannot actually replay identically after
`action_limit` changes. Recording now so whoever builds T054 designs for it (a versioned bounds
table, or bounds embedded in the stored `decision_input` at decision time) rather than discovering
it after replay already silently drifts.

## 002 batch 9 — the ceiling is enforced for `actionClass`, not yet for `hasTestedUndo`/`autonomy.level` — the `autonomy.level` half landed with Phase 4 (0.48.0, `resolveRulesetAndEvaluate`); `hasTestedUndo` still genuinely blocked on 010's catalogue, not resolved

Batch 9 fixed `actionClass` being caller-supplied and unverified (C1(b) — the ceiling could be
defeated by claiming a lower class). Both re-review passes independently flagged, correctly, that
the same bug class still applies to two other `DecisionInput` fields that `ACTION_CEILING`
consumes: **`reversibility.hasTestedUndo`** and **`autonomy.level`** are both still set directly by
the caller, with nothing on the evaluate/bind/explain path resolving them from a source of truth.

**Not a regression from this run, and not fixed here — legitimately out of scope**: resolving
`hasTestedUndo` needs 010's remediation catalogue (T048, `RemediationCataloguePublished` consumer,
Phase 5) and resolving `autonomy.level` needs `GrantAutonomy`/grant resolution (T039, Phase 4) —
neither exists in this repo yet. tasks.md already names both tasks for exactly this reason.
Recording explicitly so nobody reads C1(b)'s fix as having closed the whole "ceiling is
un-exceedable" guarantee — it closed the `actionClass` half. The other two remain caller-supplied,
hence unverified, until T039/T048 land. Any code comment claiming the ceiling is fully
un-defeatable before then is overclaiming and should be corrected to name what's actually closed.

## 002 batch 9 (round 3 re-review) — instant *literal* values still parse timezone-dependently — fixed 2026-10-02, see [decisions.md](docs/decisions.md) C-88 (`domain/predicates/instant-literal.ts`)

Batch 9 tightened `evaluatedAt` (the evaluation instant) to require an offset-qualified ISO string
(`z.string().datetime({offset:true})`), closing a replay-determinism risk (FR-002/SC-002: the same
stored input must replay identically on any host, in any timezone). The re-review found the same
class of problem still open one layer over: an `instant` **predicate's literal comparison value**
(e.g. `evaluatedAt before '2026-01-01T00:00:00'`, no offset) is still parsed with a plain
`new Date(string)` in both `validateInstantValue` (domain) and the HTTP DTO, which is
timezone-dependent — the same stored rule set could evaluate differently on hosts in different
timezones. Not fixed in this run: it's a narrower, lower-severity version of the same fix
(apply `datetime({offset:true})` to instant literals too), but expanding scope a third time on
this same batch risks never converging; recording for a deliberate follow-up decision instead —
either the next 002 session picks it up, or the person who does the eventual openapi.yaml/
error-code reconciliation pass folds it in.

## 002 T031 — `check:policy-coverage` joins on `audit_entry.policy_decision_id`, not `target_ref`

research.md R-14 names the conceptual join key `(tenant_id, action, target_id)` and explicitly
discusses and rejects one alternative (`agent_run.policy_decision_id`, because it only sees agent-
executed actions), but does not mention `audit_entry.policy_decision_id` — a column that already
exists on the table R-14 itself joins from — as a candidate at all. The first implementation
matched decisions by casting `audit_entry.target_id` to text against `policy_decision.target_ref`,
which review found couldn't verify the Invariants section's `proposal_digest` requirement (no
digest column on `audit_entry` to check it against) and rested on an unproven cast (`target_ref` is
free text, not guaranteed UUID-shaped, with no real 008/010 executor yet to prove the two fields
are ever populated from the same value).

Switched the join to `audit_entry.policy_decision_id = policy_decision.id` instead. This sidesteps
the cast entirely, and — since `ConsumeDecision` (T023) already enforces digest-match as a
precondition of setting `consumed_at` — confirming the linked decision is a consumed `ALLOW`
transitively carries the digest-match guarantee forward for free, closing the gap the target-ref
approach couldn't. Not asking whether research.md should be updated to mention this column; noting
it here since R-14 discusses the rejected alternative but not this one.

Same pass also found, live in this codebase, that `audit_entry.action` being "a registered
`policy_action.action_key`" is aspirational, not enforced: `close-issue.ts`'s `issue.close` and
`prisma-evidence-retention-repository.ts`'s `evidence.retention_purge` are both source-commented as
unregistered today. The check's `policy_action` join is `LEFT`, not `INNER`, because of this — an
unregistered action is its own violation category, reported separately from "registered but
uncovered," since an unregistered action's mutating-ness is unknown.

## 004 T001 — `DiscoveryAdapter`/`ProvenanceClass` live in `packages/domain/architecture`, not `packages/integrations`

**Decided, not deferred.** `plan.md`'s Project Structure puts adapters in `packages/integrations/*`
implementing `DiscoveryAdapter`, but doesn't say which package owns the interface itself. Put it in
`packages/domain/architecture/src/domain/discovery-adapter.ts` (the domain owns the port, adapters
are the implementations — ADR 0005's shape) and had `packages/integrations` take a new `workspace:*`
dependency on `@healer/domain-architecture` to import it. This is the first adapter package to depend
on a domain package; no lint rule forbids it.

## 004 T002/T005–T011 boundary — which guarantees T002's first migration does NOT yet enforce

**Decided, not deferred.** T002 ("Prisma models... first migration") creates every table in
data-model.md, but deliberately leaves nullable / unindexed exactly the guarantees T005/T006/T008/T009
individually own and must prove via their own red-then-green test: `graph_node`/`graph_edge`'s
`provenance`/`strength`/`confidence` NOT NULL and the two CHECK constraints (T006, proven by T005's
failing test), `valid_from_version`/`valid_to_version` plus the `graph_version` table (T008), the
partial unique index over open edge rows (T009), and `edge_provenance`'s append-only triggers (T011).
Otherwise a later "tightening" migration would have nothing to tighten and T005/T009's failing tests
would never have been red. See the relevant task's own commit for what it added.

## 004 T003 — per-element `provenance`/`layer` on `DependencyObservation` isn't constrained to its adapter's fixed constant

**Not decided, flagged for T017.** Review of T003 found that while `DiscoveryAdapter.provenance` and
`.layer` are fixed per adapter (frozen, `as const`), the wire shape `DependencyObservation` a `collect()`
returns has its *own* free `provenance`/`layer` fields — nothing stops an adapter's `collect()` from
emitting an observation whose `provenance` is stronger than the adapter's own constant. Not exploited
today (every adapter returns an empty array), and the shape itself is a placeholder — this file's own
comment already says T017 replaces it with the boundary-contract Zod-inferred type. **When T017 builds
the real `dependency_observation` schema**: prefer removing `provenance`/`layer` from the wire shape
entirely and having the discovery ingest step stamp both from the emitting adapter's fixed constant
(makes the unsafe state unrepresentable, per this repo's own pattern) over accepting the field on the
wire and validating it matches at ingest — the latter is a check that can be forgotten at a second call
site; the former has no second call site to forget it at.

## 004 T002/T005–T011 — schema build-out: judgment calls

Foundational (T002, T005–T011) is done: 5 migrations (`20261003000000`–`20261003040000`), all
round-trip-verified (forward, `down.sql` reverse, re-apply) against a real disposable Postgres, plus
the repo's own `prisma/migration.e2e.test.ts` "reverses every migration cleanly" test across full
history. 48/48 new+existing tests pass, `db-check` clean, no schema/migration drift.

- **Tenant scoping added beyond data-model.md's literal field lists**: all six attr tables
  (`component_attr`, `deployment_unit_attr`, `repository_attr`, `endpoint_attr`, `feature_attr`,
  `flow_attr`) and `discovery_source_outcome` got `tenant_id` + a leading index, though the doc keys
  the attr tables purely by `node_id` and omits `tenant_id` from `discovery_source_outcome`'s field
  list. **Decided, not deferred**: `.claude/rules/prisma-migrations.md`'s inviolable rule ("every
  tenant-scoped table has `tenant_id` and a leading index") isn't optional, and the repo's own
  `db-check` gate caught the omission live. `data-model.md` now has a "T002 implementation notes"
  section recording this. `discovery_source_outcome`'s sibling tables (`discovery_draft`, `draft_item`)
  already listed `tenant_id` explicitly, so the omission reads as a doc oversight, not a decision to
  revisit.
- **`graph_edge` had two interim plain tenant-leading indexes at T002** (`(tenant_id, from_node_id)`,
  `(tenant_id, to_node_id)`) to satisfy `db-check` before versioning existed; T008 drops both,
  replacing them with the version-aware composites data-model.md specifies. No action needed — this
  is expected T002→T008 churn, not a leftover.
- **`discovery_draft`'s SC-006a columns are named for the first time**: `proposals_count`,
  `accepted_unchanged_count` (alongside `review_seconds`) — data-model.md names the concepts, not
  columns. Naming decided, not escalated.
- **`proposal_rejection`** uses composite PK `(tenant_id, proposal_digest)` rather than a surrogate
  `id` — matches how the table is actually looked up (FR-011's dedup check), no surrogate needed.
- **`edge_provenance` has no `actor_ref` column, so it cannot name a human for a
  `human_authored`/`human_confirmed` row** — data-model.md's literal field list omits it, unlike
  `graph_node`/`graph_edge` which both have `actor_ref`. **Decided, not escalated**: `edge_provenance`
  exists to keep *discovery's* contributing observations inspectable when several sources produce the
  same edge (FR-008) — it is not where a human confirmation or manual edit is recorded (that's
  `graph_edge.state`/`.provenance` directly, audited via `audit_entry` per FR-025). In practice
  `edge_provenance.provenance` will only ever hold a `derived_from_*`/`inferred_from_convention`
  value; reusing the full `ProvenanceClass` enum on the column is for type consistency, not because a
  human row is expected there. `observation_ref` stays nullable so this doesn't block anything.
  Revisit if a later task actually needs to write a human-provenance `edge_provenance` row.
- **T006's CHECK constraints apply only to `graph_node`**, not `graph_edge` — `graph_edge` has no
  `observation_ref`/`actor_ref` columns in data-model.md's field list at all, so the two CHECKs
  (which reference those columns) can't apply there. Only the `NOT NULL`s on
  `provenance`/`strength`/`confidence`/`layer` apply to both tables.
- **T011's max-maintenance mechanism**: an `AFTER INSERT` trigger on `edge_provenance` running
  `UPDATE graph_edge SET strength = GREATEST(strength, NEW.strength), confidence =
  GREATEST(confidence, NEW.confidence) WHERE id = NEW.edge_id AND tenant_id = NEW.tenant_id` —
  incremental `GREATEST` against the current column, not a full `MAX()` re-aggregation over every
  `edge_provenance` row on each insert. Correct because `edge_provenance` is insert-only, so the
  running value is always already the max of everything inserted so far; cheaper than re-aggregating.
- **FK policy**: composite tenant-safe FKs only on the "hard" structural relationships data-model.md
  states explicitly (`graph_edge`→`graph_node` both ends, `edge_provenance`→`graph_edge`, attr
  tables→`graph_node`, `discovery_draft`/`discovery_source_outcome`→`discovery_run`,
  `draft_item`→`discovery_draft`). Left as plain scalar columns, no FK: `graph_node.discoveryRunId`,
  `graph_node.observationRef`, `edge_provenance.observationRef`/`discoveryRunId`,
  `draft_item.targetNodeId`/`targetEdgeId`, `drift_finding.issueId` — mirrors this repo's existing
  convention (`Issue.componentId`, `Evidence.producedByStep` also have no FK).

## Review of T002/T005–T011 — 2 findings fixed, 1 spec gap escalated, 1 noted for T040

Two independent reviews (code-reviewer, silent-failure-hunter) ran real fault-injection against a live
Postgres — reverted a guard, confirmed the test actually goes red for the right reason, restored it —
rather than reading the code alone. Results:

**Fixed** (see the commit that follows this entry):
- The `edge_provenance` max-maintenance trigger mutated `graph_edge` rows with no
  `valid_to_version` filter, silently rewriting **closed/historical** edge versions — reproduced: an
  edge closed at `valid_to_version = 1` changed after a later `edge_provenance` insert, which breaks
  FR-014/SC-005 ("a pinned query is stable"). Fixed to filter to the open row only and to recompute
  via a real `MAX()` aggregate over `edge_provenance` rather than an incremental `GREATEST` against
  the edge's own current value (the incremental form could be inflated by the edge's own founding
  value if that value were ever set independently of an `edge_provenance` row).
- The six attribute tables' FKs referenced `graph_node(id)` alone rather than the composite
  `(id, tenant_id)` every other child table in this migration uses — reproduced: a `component_attr`
  row with tenant B's `tenant_id` pointing at tenant A's node was accepted. Fixed by amending T002's
  migration directly (not yet pushed/shared, so amending is allowed per `prisma-migrations.md`) to the
  composite FK, plus the supporting unique constraint on `graph_node(id, tenant_id)`.
- `edge_provenance` had no CHECK requiring `observation_ref` for a non-human provenance class,
  unlike `graph_node` — added, mirroring `graph_node`'s rule.
- Added `CHECK (confidence BETWEEN 0 AND 100)` on `graph_node`/`graph_edge` (data-model.md's own
  field description, just not previously a CHECK) and `CHECK (valid_from_version <=
  valid_to_version)` on both — cheap, unambiguous structural invariants.
- `prisma/migration.e2e.test.ts`'s reversal check didn't cover the `architecture` schema at all (a
  hardcoded schema list predating 004), and T002's `down.sql` never dropped it — both fixed; the test
  was confirmed to go red first when `DROP SCHEMA` was missing, then green after adding it.
- `graph-node-rename-race.e2e.test.ts`'s inline comment paraphrased 001's `transition()` investigation
  ("SERIALIZABLE + a guarded UPDATE, either alone, measurably let both writers through") as if it were
  established for this code — 23 trials with the guard removed (isolation still SERIALIZABLE) and 11
  with isolation dropped (guard still present) both passed clean for this specific race shape; only
  removing both reproduced a real lost update. The comment overclaimed what's been verified *here*.
  Softened the comment to what's actually shown, and added repeated trials to the race test itself —
  given 001's own history of this exact class of Postgres-serialization-conflict intermittency taking
  150+ trials to characterize (`QUESTIONS.md` "Residual, investigated, not resolved" era), a single
  green run is weak evidence, so the test now runs the race several times rather than once.

**Noted, no fix needed now** (explicitly future work, tracked by an existing task):
- Nothing yet enforces that a `graph_edge`'s founding `strength`/`confidence` (set at the edge's own
  INSERT) is backed by a corresponding `edge_provenance` row — the T011 trigger only *raises* the
  value when a provenance row arrives, it doesn't require one to exist. This becomes exploitable only
  once a real "create graph_edge" command exists (Phase 3+, out of this batch's scope), and
  `tasks.md`/`quickstart.md` already name the compensating continuous check (`check:edge-strength-max`,
  task **T040** — not yet implemented). Flagging here so it isn't lost by the time T040's owner looks
  for what it's supposed to catch.

**Escalated — added to the Pavlo index below. Resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-87:**
- `graph_edge` has no `actor_ref` or `observation_ref` column at all (unlike `graph_node`, which has
  both), so a directly human-authored or human-confirmed edge — one that doesn't arrive through
  discovery's `edge_provenance` — has nowhere to record who asserted it or what it's based on. This
  is tangled with a second gap: `research.md`'s R-04a says `edge_provenance` rows carry their own
  `valid_from`/`valid_to` range and "surviving provenance is copied forward" when an edge mutates, but
  `data-model.md`'s literal `edge_provenance` field list has no range columns, and what got built
  matches `data-model.md` (no versioning on `edge_provenance`). Per AGENTS.md's own rule ("if a
  document and the code disagree, say which is stale, don't pick the convenient one"), this needs a
  call: is R-04a aspirational text `data-model.md` correctly simplified away from, or does
  `edge_provenance` need both a version range and a way to name a human actor, with `data-model.md`
  the one that's incomplete? Nothing currently in T001–T017's scope needs a human-authored edge with
  no discovery observation behind it, so this doesn't block the batch — but the checkpoint's "an
  element without provenance cannot be persisted" is only fully proven for the shapes the schema can
  currently express, and a human-direct edge currently can't be expressed at all.

## Decisions waiting on Pavlo — 004 (index; detail in the named sections above)

1. **Resolved 2026-10-02, see [decisions.md](docs/decisions.md) C-87.** Can a human directly author or confirm a `graph_edge` with no discovery observation behind it?
   Today the schema has no column to record that on the edge itself, and `research.md` (R-04a) and
   `data-model.md` disagree on whether `edge_provenance` should carry versioning and a human actor
   reference. See "Review of T002/T005–T011" above. Not blocking — nothing in T001–T017 needs this
   path yet.
2. ~~`dependency_observation`'s `layer`/`provenance` enums duplicated between `boundary-contract` and
   `domain/architecture`~~ — **resolved**, see "Review of T016/T017" below: both independent reviews
   found the same gap and a real fix existed (`domain/architecture` derives from `boundary-contract`
   instead of duplicating, since the dependency already runs that direction). No longer open.

## 004 T012–T015 — judgment calls

- **T012 was already satisfied** by the Foundational work: the only repository that exists,
  `GraphNodeRepository.renameNaturalKey`, already takes `TenantScoped<{id}>`. No query/read
  repository exists yet (correctly out of scope — that's Phase 3+). Added only the missing
  compile-proof test (`graph-node-repository.test.ts`, mirroring `domain/issues`'s
  `@ts-expect-error`/`expectTypeOf` pattern).
- **T013/T014 have no consumer yet** — the read envelope and the four outbox event builders are
  established shapes with no caller, same as 001's own precedent (`QUESTIONS.md`'s "seven of the
  eleven contract events have no publisher yet" — normal for this repo's build order, not a gap).
- **T015 — no capability/credential registry exists anywhere in the repo yet** (002-policy hasn't
  built one, and it's out of bounds regardless). Decided, not escalated: built a textual structural
  gate (`scripts/gates/graph-confirm-capability.mjs`, same shape as the existing
  `gate-architecture-agnostic`) that scans for anything shaped like a confirm path in
  `apps/mcp-server`/`apps/worker`/`apps/api`/`**/application/commands/**` and fails if it doesn't also
  reference the new `GRAPH_CONFIRM_CAPABILITY` constant. Necessarily vacuous today (nothing to catch
  yet — Phase 3 adds `ConfirmDraftItems`), proven to actually catch a fixture violation. Textual, not
  AST-based — same honesty level as `gate-architecture-agnostic` already has, flagged as a future
  hardening if it proves too weak once a real confirm command exists.
- **The new gate is runnable (`pnpm run gate-graph-confirm-capability`) but deliberately not wired
  into `make ci` or `specs/012-engineering-foundation/contracts/make-targets.md`** — that file is
  explicitly normative and owned by 012, out of this session's scope to edit unilaterally. Whoever
  owns 012's contract (or picks up 004's next phase) should add the one-line wiring once they've
  looked at it.

**Superseded by review** (see next entry): the gate is now wired into `make ci` and has a row in
`specs/012-engineering-foundation/contracts/make-targets.md`, following the precedent that
`gate-architecture-agnostic` — also 004-owned — already has one there. The caution above turned out
to be more conservative than necessary once that precedent was checked.

## Review of T012–T015 — the T015 gate was genuinely too weak, now substantially hardened

Two independent reviews found the initial `gate-graph-confirm-capability` had real, reproduced
bypasses, not just style nits — worth recording in detail since this is a security-relevant gate
(R-09's "withheld by default" guarantee) and the failure mode (a check that *looks* like enforcement
but isn't) is exactly what this repo's own patterns warn against.

**Fixed**:
- The pass condition was backwards for `apps/mcp-server`/`apps/worker`/`apps/api`: mentioning
  `GRAPH_CONFIRM_CAPABILITY` passed the gate even when that mention *granted* the capability (e.g. a
  tool declaring `requires: [GRAPH_CONFIRM_CAPABILITY]`). Now those three app roots fail on any
  confirm-shaped match, no escape hatch; "must reference the constant" is scoped to
  `**/application/commands/**` and `packages/domain/architecture/src/infrastructure/**` only, where
  a real capability check is a legitimate thing to see.
- `apps/runner/src` and `packages/agents` — exactly where the Change Agent/Verifier execute per ADR
  0010 — weren't scanned at all. Now scanned, and `GRAPH_CONFIRM_CAPABILITY`/`'graph:confirm'` must
  not appear there at all (that surface should never reference the capability — only a future
  credential-issuing layer decides what a credential carries, and it isn't this).
- The shared `scripts/lib/strip-comments.mjs` (also used by `gate-architecture-agnostic`,
  `gate-isolation`, `gate-coverage-completeness`) did a naive `.replace(/\/\/.*$/gm, '')` — reproduced:
  a line building a `"https://..."` string and registering a confirm-shaped tool in the same statement
  made the tool registration invisible, with zero capability check, and this is common style, not a
  contrived edge case. Rewritten on `ts.createScanner` (TypeScript's already a dependency, nothing new
  added). **While rewriting it, a second, independent bug was found and fixed in the same pass**: the
  scanner didn't know how to resume a template literal after a `${...}` interpolation closes, which
  silently corrupted every token afterward — this actually broke `gate-architecture-agnostic` against
  a real file (`packages/domain/evidence/src/domain/evidence-required.ts`, a "Prisma" mention inside a
  doc comment after an earlier interpolated template) the moment the rewrite first landed. Fixed by
  tracking template brace-depth and calling `reScanTemplateToken()`. All four affected gates re-verified
  passing after both fixes.
- Pattern was simultaneously too loose (missed `RejectDraftItems`/`approveDraftItems`/`acceptDraft` —
  the spec's own language uses "accepted") and too narrow (only scanned `application/commands/**`,
  missed `infrastructure/**`) and prone to false positives (would have flagged this same batch's own
  `confirmationState` field). Fixed: word-bounded `reject|approve|accept` added, `confirmationState`
  masked out, `infrastructure/**` now scanned, every issue reports `path:line` matching
  `gate-architecture-agnostic`'s convention.
- Not wired into the Makefile (`.PHONY`/target/`ci:` recipe) despite having its own CLI entry point —
  fixed, matching `gate-architecture-agnostic`'s exact shape, plus the make-targets.md row noted above.

**Accepted, not fixed — a documented, honest limit, not a gap someone missed**: a factory/loop tool
registration pattern with a dynamically-constructed name (`'graph_' + 'confirm' + '_draft'`, or
`[...].join('_')`) defeats the gate entirely — no glob or regex catches it, short of real static
analysis this gate deliberately isn't. The gate's own header comment now says this plainly, and a test
documents the gap as `KNOWN GAP` rather than pretending to catch it. **This is why the gate is framed
as a best-effort structural drift detector, not the actual security boundary** — the real guarantee
R-09 needs (no agent/automation credential ever carries `graph:confirm`) has to come from whatever
eventually mints those credentials (002-policy's territory, not built yet) simply never including it
in a closed capability list, the same "closed list, one authority" principle this repo already applies
elsewhere. Nothing to escalate here — this is an engineering limitation everyone would agree on, not
a decision.

**Also fixed**: `ReadEnvelope.confirmationState` was a free parameter that could contradict its own
`coverage` counts and, being a plain interface, was constructible without going through
`toReadEnvelope`'s checks at all — now derived inside the constructor from `coverage` plus a
`discovered: boolean` input, making the contradiction unrepresentable rather than merely unchecked.
`graph-event-publisher.ts` (T014's four `publishX` wrappers) was deleted — no precedent anywhere in
the repo (every existing emitter calls `enqueue(...)` directly at the mutation site) and zero real
callers. `GraphElementStale`'s payload now carries `nodeId` (was only on the envelope's `subjectId`,
so `payload.nodeId` would have been `undefined` against a consumer reading the contract literally).
`GraphVersionPublishedPayload` is now a discriminated union on `mintedBy`: `'confirmation'`/
`'drift_resolution'` require `actorRef` (FR-010), the other two leave it optional.

**Deferred, noted, not fixed** (explicitly lower-value / expands blast radius for little gain):
`changedElementCounts: Record<string, number>` stays loosely typed until a real consumer (006/008/011)
exists to type it against; `requireCorrelationId()` remains duplicated a third time across
`domain/architecture`/`domain/evidence`/`domain/issues` — pre-existing pattern, not introduced by this
diff, and consolidating it means touching two already-shipped 001 packages for a nit.

## 004 T016/T017 — 012 had already pre-built the four discovery shapes, with the wrong fields

**Cross-session finding, worth session B and Pavlo both seeing.** `packages/boundary-contract/src/index.ts`
already had placeholder Zod schemas for all four shapes (`component_candidate`,
`deployment_unit_candidate`, `dependency_observation`, `repository_ref`), and
`contracts/runner-protocol.md` already had their table rows — built during 012 T040, presumably
because 012's own "every fact family gets its own row" rule (C-20) meant 012 added rows for shapes it
knew 004 would need before 004 existed to specify them precisely. Their fields were generic
approximations (`identifier`/`type`/`source`, a `Record<string,string>` for characteristics, no
`adapterKey`/`adapterVersion`, a single `window: string` instead of split timestamps) that didn't match
`graph-contract.md` §3 at all. Confirmed nothing else in the repo depended on the old field names
(only referenced inside `boundary-contract` itself, no dedicated test pinning them) before correcting
them to the real spec — safe, pre-release, not a breaking change to anything running.

Split into a new file, `packages/boundary-contract/src/discovery-shapes.ts` — not by choice:
`index.ts` was already 445 lines (over the 400-line limit) before this task touched it. Verified
disjoint from session B's concurrent edits to the same file (their `DirectiveEnvelope` block and
`runner-registration.js` export sit in different line ranges) by diffing their branch's exact tip
twice, once before and once after committing.

**One judgment call worth your review, flagged by the implementing agent as the one it'd most want
overridden if you disagree**: `dependency_observation`'s `layer`/`provenance` fields are `z.enum([...])`
with values *copied* from `packages/domain/architecture/src/domain/provenance.ts`'s `GraphLayer`/
`ProvenanceClass`, not imported from there — `packages/boundary-contract` has zero workspace
dependencies by design (the execution boundary can't know about domain packages; the dependency runs
the other way), so it can't import the domain's type. The alternative was `z.string()`, which would
have silently widened these fields from a narrow closed set to any string the moment
`discovery-adapter.ts` started importing the boundary-contract-inferred type instead of its own
placeholder. Chose the enum-with-duplication over the string-with-silent-widening, on the reasoning
that a closed list copied in two places (each individually still closed) is safer than one place that
stopped being closed at all — but this is exactly the "a closed list has exactly one authority" rule's
target case, and there's no cheap way to add a same-sync check (a test in `boundary-contract` importing
from `domain-architecture` would itself be the package-direction cycle the split exists to avoid). If a
future task adds a third copy of this list, that's the sign to solve it for real rather than duplicate
again.

Also not done, left as an accurately-updated comment rather than a silent gap: the three integration
adapters' `collect()` still can't cross-check that a `dependency_observation`'s declared
`layer`/`provenance` doesn't exceed the emitting adapter's own fixed constant — there's no ingestion
code path to attach that check to yet (Phase 3/US1 isn't built, `collect()` only returns empty arrays).
Comments updated to attribute this to Phase 3 rather than pointing at T017, which is now done.

## Review of T016/T017 — the enum duplication resolved, everything else checked out clean

Both reviews mutation-tested the actual guarantees rather than reading the diff (removed `.strict()`
and confirmed T016's test goes red; stripped required fields from each of the four T017 sample
payloads one at a time and confirmed each failure) and independently converged on the same single
real finding: the `layer`/`provenance` duplication flagged as a judgment call above had a real fix,
not just a documented tradeoff. `packages/domain/architecture` already depends on
`@healer/boundary-contract` (the dependency direction I'd initially assumed only ran the other way
when weighing the tradeoff) — so `ProvenanceClass`/`GraphLayer` now derive from
`DependencyObservation['provenance']`/`['layer']` instead of being hand-copied, closing the gap to
exactly one authority. Fixed directly (small, well-specified, no need for another agent round-trip);
also fixed a wrong comment claiming a circular import that doesn't exist (only `index.ts` imports
`discovery-shapes.ts`, never the reverse).

**Noted, not fixed** (both reviews agree these are fine to leave):
- Field-by-field accuracy, `.strict()` closure, the type re-exports into `discovery-adapter.ts`, and
  the `runner-protocol.md` row updates were all independently verified correct by both reviews — no
  further changes needed there.
- The four types now carry a required `kind: '<shape>'` literal discriminant (needed because they're
  `z.infer` members of `RunnerEvidence`'s discriminated union) that the old placeholder interfaces
  didn't have — couples `DiscoveryFacts` (a domain-internal shape) to the wire-evidence tag. Not a bug
  today (nothing constructs these objects yet, every adapter returns `EMPTY_FACTS`), but the Phase 3
  implementer building real collection will need to stamp `kind` even before serializing as evidence —
  flagged so it isn't a surprise, not something to pre-fix against an interface nobody's implemented
  yet.
- No protocol version bump for what is, in the abstract, a breaking wire-shape rename — correctly
  harmless since nothing emits these shapes for real yet (every `collect()` returns empty arrays), so
  bumping now would be premature.
- graph-contract.md §3 itself says two things that pull against each other (an adapter's provenance is
  fixed "with no field to say otherwise" vs. the same section's own table putting a free `provenance`
  field on every `dependency_observation`) — already tracked above as the reason the three adapters'
  comments defer the adapter-vs-observation cross-check to Phase 3. Not new, not re-litigated here.

## `make ci` — one downstream break, fixed

Full `make ci` on the finished T001-T017 batch found two things:
- 11 files needed `prettier --write` (none of eslint/typecheck/the gates catch formatting — a
  separate check). Trivial, fixed; one of prettier's own reflows moved a `@ts-expect-error` off the
  line it was suppressing in `read-envelope.test.ts` (TS2578/TS2345) — fixed by pulling the object
  literal into a local `const` so the flagged call stays on one line.
- `packages/domain/evidence/src/application/commands/record-evidence.test.ts` (owned by **001**, not
  004) had its own FR-007a test exercising the four discovery shapes with the *old* placeholder field
  names T016/T017 just corrected. Updated to the real fields (`naturalKey`/`componentType`/etc.) —
  the only file outside 004's own packages this batch had to touch, and only because it tested a
  shape 004 owns.

The full `make ci` run also found two failures in `issue-deletion.e2e.test.ts` (001, T053):
- A test timed out at exactly 120000ms under the full suite's load. Re-ran the whole file alone —
  all 43 tests passed, that one in 6.1s. Contention, not a regression (matches 001's own documented
  history of this exact class of false failure under full-suite parallelism, and the Docker
  contention session A/B flagged earlier in this run).
- A real, deterministic failure: `architecture.drift_finding.issue_id` isn't in 001's
  `ISSUE_ID_COLUMNS` completeness gate (`prisma-issue-deletion.ts`) — its own doc comment says
  exactly this happens for "a feature that adds a table with an `issue_id`" and names 006/010 as the
  expected future cases; 004 is now one too. **Decided, not escalated**: added the column to the list
  and a `DELETE FROM architecture.drift_finding` to the cascade, alongside `evidence`/`issue_event`
  (content about the issue) rather than nulled like `agent_run.issue_id` (an independent spend
  record) — R-14 says a drift finding exists only to raise the issue for adjudication, so it has no
  life apart from it. This is the one place this batch touched a fully-shipped 001 file, and only
  because 001's own gate is designed to require exactly this.

A third `make ci` run (after the drift_finding fix) passed clean except for 001's own 12 000-signal
replay test (`ingest-signal.e2e.test.ts`, already flagged in the Pavlo index above, item 9, as
load-sensitive before 004 touched anything) — timed out at 322s standalone (found two stale leaked
Docker containers, 7h/30h old, likely contributing background load; left them alone, not mine to
clean up blind). Retried standalone once more: 59.6s total, 43.7s for the heavy test itself — matches
001's own documented "~55s alone" baseline almost exactly. Confirmed transient, not a regression —
every other test in the full suite, including everything 004 added, passed both full runs.

## 002 Phase 4 (T034-T047) — autonomy grants, ceiling, revocation, epoch, sweep

Implemented on `worktree-002-policy`, building on Phases 1-3 (already on master, VERSION 0.46.0).
Not yet committed — awaiting explicit go-ahead per standing instructions (never commit without
being asked). Judgment calls made along the way, flagged rather than blocking on them:

- **T035's "check constraint" is a trigger, not a CHECK.** Postgres `CHECK` constraints cannot
  reference another table, and the ceiling depends on `policy_action.action_class`, resolved via
  `autonomy_grant.action_key` — the same substitute the T003 append-only trigger already uses for
  a constraint plain SQL can't express. New migration `20261003060000_autonomy_grant_ceiling`
  (the existing `policy_core` migration is committed/shared and must never be edited per
  `prisma-migrations.md`). Respects the same `healer.privileged_write` bypass every other
  append-only trigger does, deliberately — quickstart 9 needs a documented way to "write an
  over-ceiling row anyway" to prove the second mechanism (`evaluate()`'s clamp) still holds.

- **`reversible_remediation` grants are refused unconditionally today, at every level including
  0.** No attestation source exists (010's catalogue isn't built), and `hasTestedUndo` has no
  honest answer other than `false` — the same reading `policy-evaluation.controller.ts`'s
  `GET /policy/actions` already gives. This is enforced three ways that all had to agree: the
  command (`grantAutonomy` calls `ACTION_CEILING(class, false)`), the DB trigger (no branch for
  that class at all), and `gate-ceiling` (deliberately excludes that class from its drift check,
  since the trigger is *more* conservative than `ceiling.ts`'s attested answer, not a copy of it —
  comparing them would fail the gate for a difference that's correct by design).

- **`autonomy.level` is now resolved from real grants, never trusted from the caller** — the same
  move batch 9 made for `action.actionClass` (`resolveRulesetAndEvaluate` now takes
  `autonomyGrants: ReadOnlyAutonomyGrantRepository` and overwrites `decisionInput.autonomy.level`
  before `evaluate()` runs). This is a required dependency on `EvaluateAndBindRepos` and
  `ExplainDecisionRepos`, same as `actions` — every existing test fixture needed a
  `FakeAutonomyGrantRepo` resolving to the fixture's own default level (2), so no existing test's
  *outcome* changed, only its repo list grew by one entry. Not a corner cut: leaving
  `autonomy.level` caller-trusted would be exactly the bypass batch 9 closed for `actionClass`.

- **T044's "redeem" has no command to attach to.** `ResolveApproval` is Phase 7 (T074), out of
  scope. Added `checkAutonomyEpoch` (`domain/check-autonomy-epoch.ts`) — the small, reusable
  redemption-time check `STALE_AUTONOMY_EPOCH` (already reserved in `@healer/shared`'s
  `ErrorCode` union, unused until now) exists for. Phase 7 calls this directly rather than
  reinventing the comparison; T044's own test exercises it against a hand-built
  `approval_request` row (the table exists from Phase 1; the lifecycle commands don't yet).

- **T045's sweep does not deliver a real callback.** `packages/workflow/src/callbacks.ts` is pure
  domain logic with no Prisma-backed delivery anywhere in this repo yet, and no scheduler exists
  to run any sweep periodically (001's staleness sweep has the identical, already-flagged gap).
  `sweepRevokedApprovals` takes an `ApprovalCallbackPort` (defined here, in `domain/`) with no
  concrete production implementation shipped in this batch — a caller wires a real one once 012
  builds the mechanism. What the sweep *does* guarantee now, atomically: the `approval_request`
  moves to `revoked` and the `policy_decision` it was issued for gets
  `invalidated_reason = 'epoch_bump'`, in one transaction, directly via `PrismaApprovalRequestRepository`
  (mirrors `PrismaAutonomyGrantRepository.revoke()` touching `autonomy_grant` + `autonomy_epoch`
  together rather than round-tripping through a second repository's interface).

- **`gate-ceiling` is two different things wearing one name** (make-targets.md's own phrasing):
  the SC-004 *data* check (this batch, T038) and the FR-008a *diff* check (Phase 9, T086/T087,
  out of scope). Built the data half as a static, DB-free comparison between `ceiling.ts`'s
  constants and the T035 trigger's hardcoded `CASE` — not a live query against `autonomy_grant`,
  because a live query is exactly what `check:ceiling` (continuous reconciliation,
  `scripts/checks/ceiling.mjs`, same convention as `check:policy-coverage`) already owns, and
  `make ci`'s other gates (`gate-data-model`, `db-check`) are all DB-free by the same convention
  (the live-DB half of schema verification lives in an e2e test, not a Makefile gate). Extend this
  gate with the diff check when Phase 9 lands, don't duplicate it.

- **`AutonomyGrantsController` and `PolicyEvaluationController` had a circular import** (each
  needed the other's DI token). Fixed by moving `AUTONOMY_GRANT_REPOSITORY` into the shared
  `policy-http.ts` (which every `/policy/*`/`/autonomy/*` controller already imports from, never
  the reverse) — found because NestJS's bootstrap failure on a real cycle crashes the whole
  worker process with a native stack trace instead of a catchable error, which only the e2e test
  actually booting the app (not a unit test) could have caught.

- **`POST /autonomy/grants` isolation test carries its marker in `environment`** — the only
  free-text field the grant DTO accepts, mirroring `POST /policy/rulesets`'s own use of `ruleKey`
  for the same purpose (`assertTenantScopedEnqueue`'s contract needs *some* field to embed a
  marker in).

## 002 Phase 6 (T056–T069) — judgment calls (budgets)

Implemented on `worktree-agent-a78aab9e73c3f9d7c` (commits `c0ca8b9`…`f43166d` plus the docs commit),
migration prefix `20261003090000_budget_limit_bounds`. `budget_limit`, `budget_degradation_mark` and
the `budget_degradation` evidence type already existed from T002/001, so the migration adds only the
T088 bounds, the scope/period CHECK and a unique key. No question blocks; the calls below are
decided, recorded here so a reviewer can overrule them.

**Not built, and why** — both are consumers this release has no code for, and both were ticked in
`tasks.md` with the gap named in the note:

- **T058's "the workflow suspends resumably".** Policy refuses: the AI step's decision is a `DENY(BUDGET_EXHAUSTED)`
  (a recorded decision, not an exception), the issue gets an evidence record naming what completed,
  and the same step proceeds once the limit is raised or the window rolls (tested). What moves the
  *run* to a suspended state is the guarded-step handler that reads that decision, which belongs to
  012's workflow definitions (006/008) and does not exist. The reader of the refusal is
  `consumeDecision`, which already refuses a non-allow decision (R-14) — so an AI step cannot run
  past it — but nothing turns the refusal into `needs_human`/suspended yet.
- **T066's hand-off to a human with evidence, hypotheses and reasons for rejection.** The evaluator
  denies with `ATTEMPT_CAP_REACHED` at the cap; assembling the hand-off package is the escalating
  workflow's job (006/009), not policy's.

**Judgment calls**

1. **`agent_run.cost` cannot be shown to be measured today** — it has no provenance column and
   nothing writes `agent_run` yet (012 T059's write path and T061/T094, "measured, never estimated",
   are deferred). `check:budget-reconcile` therefore cannot *prove* measurement; it refuses the
   forms of estimate it can see (a finished run with tokens and no cost, a negative cost, a run
   that cost more than its own step declared) and its header says so. Adding the real reconciliation
   against provider usage belongs with 012 T094, in the same check.
2. **R-11 was wrong about not needing a lock.** "The ex-ante check is what makes it safe" fails under
   READ COMMITTED (two concurrent steps both read 90 and both pass `90 + 10 <= 100`; reproduced —
   without the lock 17 of 20 charges against a limit of 10 were allowed). `research.md` R-11 now says so. The
   charge is the **declared maximum of an allowed step, carried by its persisted `policy_decision`**
   (`budget_state.reservedSpend`), an *open charge* replaced by the actual cost once a *finished*
   `agent_run` references the decision. No reservation table, no counter; resolve-and-persist run
   under one lock.
3. **An advisory lock (`pg_advisory_xact_lock`), not `FOR UPDATE`.** There is no row guaranteed to
   exist to lock: a tenant that never configured a budget runs on the fail-closed defaults and has no
   `budget_limit` row, and policy tables carry no FK to `tenant.tenant`. Per-tenant, held for the
   resolve-and-persist transaction only, **bounded** (`lock_timeout` 5 s, then a retryable
   `BudgetContentionError`/429; ADR 0015 reconciles it with 008 R-16 and ADR 0003); a step that
   declares no cost takes no lock (tested).
4. **A leaked charge, and its release.** A decision whose step never runs (worker died, step
   cancelled) stays charged at its declared maximum — fail-closed, an over-count. Review: that must
   not lock an issue out forever. `releaseAbandonedCharges` invalidates allowed, never-consumed,
   never-run decisions older than `ABANDONED_CHARGE_TTL_MS` (2 h) with the new
   `invalidated_reason = 'charge_abandoned'` — a closed list now declared once (`INVALIDATED_REASONS`,
   with a test that data-model.md and openapi.yaml agree). **No production caller schedules it**
   (no scheduler exists; the same gap as the approval sweep). **Limit**: a *consumed* decision cannot
   be invalidated (the terminal XOR CHECK), so a step that started and never finished keeps its
   charge until the run writer finalises the `agent_run`.
5. **The declared maximum is the caller's.** An AI step declaring 0 charges nothing (and takes no
   lock), so an under-declaring caller delays the refusal by one step. The actual cost still lands
   in `agent_run` and the next evaluation reads it; `check:budget-reconcile` reports any run that
   cost more than its declaration, which is the reader of this guarantee.
6. **The evaluator takes one `(consumed, limit)` pair, but a step must fit every budget** (per-issue
   and tenant day and month, spend and time). The pair handed to it is the most constrained one
   (`bindingBudget`, ties broken per-issue, day, month, spend before time) and the binding scope is
   persisted in `budget_state.binding`. When time binds, the declared maximum handed to the predicate
   is 0 (no one declares a time forecast); the declared *spend* is still reserved
   (`reservedSpend`).
7. **Units and a reading of "elapsed".** 012's `tenant_budget.time_limit` states no unit; it is read
   as milliseconds (matching `budget_limit.time_limit_ms`). `workflow_run` elapsed is to `updated_at`
   when terminal and to the evaluation instant while live, **minus the time the run was parked**
   (review H1: one slow approver must not exhaust an issue's time budget). Parked = from a
   transition into a state named `awaiting_*` (or `needs_human`) until the next transition, derived
   from `workflow_transition`. 012 has not named its waiting states, so the prefix is policy's one
   declaration of the convention; a workflow that names them otherwise is charged for waiting
   (conservative). Nothing produces such states yet either. The time bounds fit an `INTEGER`: 4 h / 24 h /
   20 days. Every bound and default (T088) is a starting value pending the stage-0 benchmark.
8. **The pinned period key is `LEAST(own start, workflow start)`.** Pinning to the workflow's start
   alone (the first version) dropped the spend of an agent run that *predates* its workflow
   (classified at ingest, say) from both windows when it crossed a day boundary: the scan pruned it
   on its own `started_at` while pinning moved it to the later window. `check:budget-reconcile`
   found this on its first run against a plant I had written to be realistic — the independent
   recomputation doing its job. Agent runs join workflow runs on `correlation_id`, which 012 does
   not make unique per run; the earliest start among runs sharing it is used.
9. **Exhaustion is step `n + 1`**, recorded like any other step (entry `ai_steps_refused`), and a
   refusal records it for the scope that refused even when consumed is still below the limit (nine
   of ten spent, a step declaring two: nothing more can run, so the budget is exhausted for every
   purpose that matters). A refusal before any threshold was crossed records only exhaustion;
   steps nothing reached are not claimed. `BudgetExhausted` is therefore published once per scope and
   period, `BudgetDegraded` once per step.
10. **Degradation marks lag by one evaluation, and need an issue.** The standing a mark records is
    the budget as resolved *before* the evaluation's own charge, so the evaluation that crosses a
    threshold is marked by the next one. Evidence is per issue (001), so a tenant-scope step is
    attached to the first issue whose evaluation sees it; an evaluation with no issue records
    nothing rather than inventing one. Both are self-healing: the step is derived, so the next
    evaluation records whatever is missing (tested by the jump-over-steps case).
11. **Policy writes the evidence row directly** (in the mark's transaction, like `recordAuditEntry`
    writes `audit_entry`) rather than through 001's repository — no domain package depends on
    another, and a separate repository transaction could not be atomic with the mark. The evidence
    id is a deterministic function of the mark's key, and `EvidenceRecorded` is mirrored locally so
    the timeline's feed still hears of the record. `expires_at` is a 400-day placeholder.
12. **The escalation attempt count is `workflow_transition` rows into `escalating` — and nothing
    produces that state.** The cap predicate is built and tested against a quantity no workflow
    increments yet (T066b, not built; un-ticked). Review: the cap applies to an *escalating*
    proposal only (new optional `escalation.escalating` on the closed `DecisionInput`, a structural
    statement by the calling feature; nothing sets it yet), so a cap of 0 stops escalation and
    nothing else, and it has its own reason code `ESCALATION_CAP_REACHED` (distinct from the
    per-action `ATTEMPT_CAP_REACHED`; a new value on the `policy_reason_code` enum, migration
    `20261003110000`, whose down-script cannot remove it). 012/006 own
    the state graph and have not named an escalation state; `ESCALATION_TO_STATE` is the one place
    policy names it. A workflow that names it differently is simply not counted — change the
    constant, not the callers. The cap is the tightest `budget_limit.escalation_attempt_cap` that
    applies (012's `tenant_budget` has none), default 2 (fail closed), and is persisted in
    `budget_state` so a replay re-applies it (`replayDecision` takes an optional `budgetState`).
13. **`PUT /budgets` merges over the limit *in force*.** The contract makes only `scopeType` and
    `period` required, so an omitted field keeps what is in force — the stored row, else 012's
    `tenant_budget`, else the fail-closed default; never "unbounded", and never reverting an
    inherited limit to a default (review #5). The merge happens inside the transaction that writes,
    under a per-tenant configuration lock, so concurrent partial writes are both kept, and the
    *merged* result is bounded. Soft thresholds outside 1–99, or more than 5, are 422 — never
    silently dropped (`BUDGET_BOUNDS.maxSoftThresholds`, CHECK-agreed). A NULL threshold column is
    reported as what is enforced (the default), not `[]`. 012 `tenant_budget` values that were
    replaced by a fail-closed value (unknown degradation entry, out-of-range threshold) come back as
    `warnings` on the resolved budget / `GET /budgets/state` and are logged. A refused write is not
    audited (recorded, not built). `scope_id` NULL means "every issue" for the per-issue limit; an issue-specific
    override row is honoured by resolution but has no API yet. `GET /budgets/state` gained optional
    `period` (tenant day or month, default day) and `workflowRunId` (pins the period key); the
    contract yaml says so.
14. **Every evaluation now overwrites `budget.{consumed, limit, degradationStep}` and
    `escalation.attemptCount`** from the aggregate, like `autonomy.level` and `actionClass` before
    them (**the dry run now takes an optional `issueId`/`workflowRunId` query so it resolves the same
    binding as the enforcing path**, review I4 — tested: an over-budget issue is deny in both; the
    caller's budget figures are ignored and documented as such in evaluation.md) (same
    required-dependency move: `budgets` on `EvaluateAndBindRepos` and
    `ExplainDecisionRepos`). Two existing e2e tests changed their *input plumbing*, and one its
    expectation: with nothing configured the per-issue default (2) binds, tighter than the 100 the
    test's input claimed (`policy-decision-repository.e2e.test.ts`). The dry-run endpoint resolves
    tenant-level figures only (it carries no issue).
15. **Where `check:budget-reconcile` is wired into `make ci`:** every budget e2e scenario
    (`budget-enforcement`, `budget-flood`) ends by running `findBudgetDiscrepancies` over what it
    left behind, and `scripts/checks/budget-reconcile.e2e.test.ts` runs it over a deliberately
    awkward tenant (midnight straddle, in-flight, landed, terminal and live runs) and proves a
    disagreement, an unpriced run and an over-declared run are each reported — all under `make
    test-e2e`. There is no separate Makefile target, matching `check:ceiling` and
    `check:policy-coverage`, which are production monitors with their e2e tests as the CI reader.
16. **Test plumbing.** The shared e2e harness lives in `test/infrastructure/` because
    `@healer/prisma-client` is lint-restricted to `infrastructure/**` and the harness constructs the
    client; `test/tenant-isolation.ts`'s `assertTenantIsolated` gained an optional `queryFor` so a
    route that names its resource in the query string (`/budgets/state`) can use it. The flood test
    is in `HEAVY_E2E` (≈9 s alone, serialized behind the charge lock).
17. **`createApiModule` gained two trailing parameters** (`budgets`, `budgetLimits`); every call
    site was updated by hand (ingest ×1 of 2 — the second, a 503 test, already passed fewer
    arguments than the signature and still does, runners, load, issues, issue-close-and-views,
    policy, autonomy-grants, `main.e2e`, `openapi.ts`, `main.ts`). The implementer of approvals
    (T070–T076) will have appended parameters too: merge by keeping both, then regenerate
    `apps/api/openapi.json` (`pnpm run generate:openapi`) rather than merging it by hand. Also appended
    here: `policy.update_budget` in `SEED_POLICY_ACTIONS` and `scripts/db-seed.mjs`, and
    `budget-flood.e2e.test.ts` in `HEAVY_E2E`.


### Review round on the budgets work — outcomes and judgment calls

Two independent reviews (code-reviewer, silent-failure-hunter), fixed in follow-up commits on the same
branch; migration prefix `20261003110000_budget_hardening` (a reason-code enum value and
`policy_decision.request_key` with a partial unique index). Items 1–15 above are amended in place where
they changed.

- **Idempotent charge.** A charged step carries `request_key` (the request with resolved fields and
  the instant removed); under the lock a retry of the same `(tenant, run, state, request)` returns the
  live allowed decision. Only a step bound to a run *and* a state can be deduplicated; a decision that
  charged nothing is not (a retried deny is harmless). A deny is not deduplicated either, so a retry
  after the budget was raised is evaluated afresh — deliberate.
- **Failure after commit.** `markDegradation` failing is logged (`repos.log`, structured, tenant-tagged)
  and swallowed: the next evaluation records the missing step (it is derived). The autonomy epoch is
  read *before* anything is charged, so a revocation during the lock wait is not hidden and its failure
  cannot strand a committed decision.
- **Binding is validated inside the charge transaction.** An unknown, malformed or other-tenant issue
  or workflow run is `NotFoundError` (404) before any charge commits — for evaluation, dry run and
  `GET /budgets/state` alike. An *enforcing* evaluation also refuses an `evaluatedAt` more than 5 min
  from the database clock (`EvaluationInstantError`, 422); a read is not bound, because a dry run
  replays history. The bound is a repository option (`maxEvaluationSkewMs`, `Infinity` disables); the
  e2e tests that evaluate at fixed historical instants pass `Infinity`, production wiring takes the
  default, and a dedicated test proves the default refuses.
- **Existing e2e tests changed** because bindings are now validated: they seed the issue and workflow
  run they bind (`policy-decision-repository`, `autonomy-grant-resolution`).
- **Issue deletion** now deletes the issue-scope marks, issue-scope limit overrides and the marks
  whose evidence went with the issue (001's `prisma-issue-deletion.ts`, one statement pair). A
  tenant-scope step whose evidence was the deleted issue's is recorded afresh by the next evaluation,
  attached to an issue that exists.
- **`completedAgentRuns`** is capped at 50 and says `completedAgentRunsTruncated: true` past it.
- **`check:budget-reconcile`**: recomputes parked-aware time; flags a run whose `policy_decision_id`
  names no decision, another tenant's decision, or a non-allow; takes `tenantIds` so a shared test
  database's deliberate plants do not fail an unrelated assertion.
- **ESCALATION state / T058b / T066b** un-ticked and split; T060 and T069 notes corrected (no
  scheduled production caller for the release command or the reconcile).
- **Not done, recorded.** (a) Exhaustion evidence can become false later (a limit raised after the
  record): the record is a statement *at that step*, with the figures and period key it carries. (b)
  An evaluation with no issue binds records no degradation step (evidence is per issue); the next one
  with an issue does. (c) The finished-cost pin (by `correlation_id`) and the open-charge pin (by
  `workflow_run_id`) can disagree when a decision's agent run lands under a different workflow run;
  the reconcile compares each side against the same JS definition, so it would show the drift, but they
  are not unified. (d) `check:budget-reconcile` does not iterate keys present only on the SQL side
  (it walks the keys the raw rows imply). (e) A refused `PUT /budgets` is not audited. (f) A
  `require_approval` decision reserves no charge: when approvals redeems it nothing is charged
  ex ante — Phase 7 must either charge at redemption or declare approvals cost-free; approvals did
  not add a charge. (g) `bindingBudget` breaks an exact spend/time ratio tie by a fixed order, not by
  which dimension is closer to refusing in absolute terms.
- **ADR 0015** records the lock decision and indexes it in docs/README.md; research R-11 is rewritten
  as one consolidated decision rather than a decision plus an appended correction.

## 002 Phase 7 (T070–T076) — judgment calls (approvals)

Decided, not asked. Branch `worktree-002-phase6-7-budgets-approvals` (implementer B).

- **No migration.** `approval_request` (unique `decision_id`, index `(tenant_id, state, expires_at)`)
  already existed from T002 and already fits. `data-model.md` gained implementation notes only.
- **"Redeem" is `ResolveApproval`.** There is no executor to redeem against yet, so the human's
  click is the redemption point and `checkAutonomyEpoch` runs there, inside the transaction, under
  the row lock (`assertRedeemable`: not pending / lapsed → `APPROVAL_NOT_PENDING`, then stale epoch
  → `STALE_AUTONOMY_EPOCH`). An approval granted and *then* revoked is covered by R-07 mechanism 1
  (the executor re-evaluates; nothing is carried across the wait), not by a second "redeem"
  command. **Open, spec-silent:** how an `approved` request turns the executor's re-evaluation into
  an `ALLOW` — `REQUIRE_APPROVAL` decisions are (correctly) unconsumable and nothing in 002 mints
  an `ALLOW` from an approval. That belongs to whoever builds the first executor (008/010); not
  invented here.
- **The summary is built, never supplied.** `RequestApproval` takes a decision id and evidence ids,
  nothing else; `buildApprovalSummary` reads the stored decision and every free-string slot must fit
  the identifier alphabet (no whitespace). Consequence worth knowing: a decision whose `targetRef`
  (etc.) holds a sentence is *refused* (`ApprovalSummaryNotStructuralError`), loudly, instead of
  rendered. The rule `note` (data-model says "shown in the approval summary") is **not** included:
  T070's list does not name it and it is tenant-authored free text; add it through the same closed
  schema if wanted.
- **"Against which rule set version"** = the decision's own immutable `ruleset_version`, written
  into the resolve `audit_entry` reason and returned as `rulesetVersion`. Not "the version published
  at click time" — the approver saw, and approved, what that version decided.
- **Projection pulls the run's deadline earlier.** `expires_at = min(requested, run.deadline_at)`
  and `workflow_run.deadline_at` is set to it, so the tick that fires the expiry exists by
  construction. No expiry requested and no run deadline → refused (nothing would fire it).
- **Run effects are direct writes to 012's tables.** 012's machine has no persisted stepper and no
  `awaiting_approval`/`needs_human` definition in this repo, so parking (`awaiting`, `deadline_at`,
  a `workflow_callback` row of kind `approval`, token generated and discarded — a human resolves
  through the authenticated API) and the lapse (`state = needs_human`, `terminal_state`, a
  `workflow_transition` with cause `timeout`) are written in the same transaction by
  `approval-run-effects.ts`. Callback delivery for resolve/expire is in-transaction (consume the
  row, repeats count). (A port for the T045 sweep was added here and later removed — see the review follow-up below.)
- **A lapse is a recorded `DENY`, not an evaluation.** `deny` + `APPROVAL_EXPIRED`, no matched
  rules, the original decision's input/digest/ruleset version; the original is invalidated with
  `approval_expired`. It cannot replay (no input maps to a rule-less deny), so `check:decision-replay`
  skips decisions of exactly that shape (`reason_codes ∋ APPROVAL_EXPIRED` and no matched rule keys).
  `POST /policy/decisions/{id}/replay` on a lapse decision will therefore report non-identical;
  left alone (an explicit read of an explicit fact).
- **Sweep `revoke()` now takes the row lock** (T045 code, `FOR UPDATE` via the shared
  `lockApproval`). Without it the sweep's read-then-write could overwrite an approval a human
  committed an instant earlier — same bug class as resolve vs expire. One-line semantic change.
- **Tick body, not a scheduler.** `expireDueApprovals` is the per-tenant body of the
  `deadline_at` tick; no scheduler exists anywhere in this repository to call it (the same gap as
  001's staleness sweep and T045's sweep). It is idempotent and one failing request does not block
  the rest.
- **`check:stale-approvals` wiring (T076).** `npm run check:stale-approvals` runs against the live
  DB like its four siblings (not in `make ci`: CI has no production database). What `make ci`
  *does* run is `approval-lifecycle.e2e.test.ts` (inside `make test-e2e`), which seeds each
  violation shape — overdue, unfireable (no/short run deadline), orphaned (terminal run) — and
  asserts the query reports it, and seeds healthy/expired requests and asserts it does not;
  mutation-checked. Honest gap: nothing schedules the live run yet.
- **Races proven, not slept.** Resolve vs expire: a held `FOR UPDATE` on the approval row, both
  contenders polled into `pg_stat_activity` lock waits, then released; exactly one wins (5 repeats).
  Removing `FOR UPDATE` makes both win. Residual: `autonomy_epoch` is read `FOR SHARE`, which only
  serialises against a revocation when the row exists; a tenant's *first-ever* revocation inserts it
  and cannot be blocked. The window is the length of one resolve transaction and the outcome is the
  same as a revocation landing a millisecond later.
- **Error codes.** `APPROVAL_NOT_PENDING` is a contract-level name; `@healer/shared`'s closed
  `ErrorCode` has no such member and `ApprovalNotPendingError` (T045) carries `PRECONDITION_FAILED`.
  The HTTP controller maps it and `STALE_AUTONOMY_EPOCH` to `409`; the shared list was not touched.
  `APPROVAL_EXPIRED` and `STALE_AUTONOMY_EPOCH` are referenced from their one authority
  (`REASON_CODES`, `ERROR_CODES`), not redeclared.
- **Registry.** Three audit actions (`policy.request_approval`, `policy.resolve_approval`,
  `policy.expire_approval`, `mutating: false`, same reasoning as publish/grant/revoke) added to
  `SEED_POLICY_ACTIONS` **and** the hand-synced `scripts/db-seed.mjs` copy, or
  `check:policy-coverage` would flag every approval audit entry as unregistered.
- **`createApiModule` gained a 14th parameter (`approvals`).** All ten call sites were edited by
  hand. One of them (`ingest.e2e.test.ts`, the 503 test) had been missing the 13th (`autonomyGrants`)
  since Phase 4 — e2e tests are outside `tsc`'s `include`, so nothing flagged it; both are passed now.
- **Duplication kept small on purpose:** the lapse decision's `INSERT` repeats `record()`'s column
  list instead of refactoring `PrismaPolicyDecisionRepository` (another implementer is in this
  package); fold the two together once Phase 6 lands.
- **T032 extended** in `apps/api/policy.e2e.test.ts`: approval read, list and resolve are 404
  cross-tenant (mutation-checked: dropping `tenantId` from `findById` fails it; resolve is also
  protected independently by the tenant-scoped row lock). Endpoint behaviour is
  `apps/api/approvals.e2e.test.ts`.

### 002 Phase 7 — review follow-up (two independent reviews of the branch)

Fixed (item numbers are the coordinator's):

1. **One approval per run, callback bound to its approval.** *Refuse*, not return-existing, when the
   locked run already has a pending request or awaits something other than an approval
   (`ApprovalAlreadyPendingError`); a repeat for the **same decision** still returns the existing
   request (idempotency). A run whose marker belongs to a *resolved* approval may be re-parked
   (resolve clears `awaiting`). Binding needed a **migration
   `20261003100000_approval_callback_binding`** (with `down.sql`): nullable unique
   `workflow.workflow_callback.approval_id`, no FK so 012 does not depend on 002. It adds a column to
   012's table from 002's branch — flag for 012's owner. Delivery is by that key in resolve, expire
   and revoke.
2. `request()` idempotency read is `findFirst({decisionId, tenantId})`. Not separately
   mutation-testable (the run lock already 404s a foreign run first); a one-line correctness fix.
3. `RequestApproval` takes `evaluateAndBind`'s `autonomyEpoch`, records it, and refuses
   `STALE_AUTONOMY_EPOCH` if no longer current; refuses a consumed/invalidated decision; refuses
   `evidenceIds: []` (the approver "sees the evidence").
4. `ResolveApproval` locks the run (after the approval, same order as expire) and refuses a terminal
   run with `ApprovalRunTerminalError` (409). **`rejected` means:** the original decision is
   invalidated with the new reason `approval_rejected` (data-model + openapi.yaml enum extended;
   `invalidated_reason` is free text in the DB, so no migration for that), the callback is
   delivered, and the run goes to terminal `needs_human` with a `human`-cause transition.
   **Approve** delivers the callback and clears `awaiting`; the run's state is left for its stepper.
5. `deliverApprovalCallback` throws `NotFoundError` when nothing matches; the surrounding
   transaction rolls back.
6. `expireDueApprovals` and `sweepRevokedApprovals` skip only `ApprovalNotPendingError`.
7. Sweep `revoke()` now delivers the callback, moves the run to `needs_human` (cause `policy`) and
   audits (`policy.revoke_approval`, registered in both seed lists) in the revoke's transaction. The
   `ApprovalCallbackPort` and its Prisma implementation were **deleted** (nothing uses an
   out-of-transaction port any more); `sweepRevokedApprovals` lost its `callback` parameter. **Not
   done:** no outbox event on revoke — the contract's event table has no `ApprovalRevoked`, and
   inventing one is a spec change.
8. `check:stale-approvals` also reports: a run `awaiting` an approval with no pending request; a
   pending request with no unconsumed `approval` callback; a request whose run does not exist
   (explicit message). Seeded-violation tests for each.
9. `check:decision-replay` exempts a lapse only if `deny` + exactly `['APPROVAL_EXPIRED']` + no
   matched rules **and** an `expired` request on the same run **and** an original decision with
   `approval_expired` and the same digest. A forged lapse-shaped row is flagged (tested).
10. `findDue` returns `{id, expiresAt}` only. `list()` parses per row and omits a malformed row with
    a structured error log (id + failing paths, never content); `findById` still raises for that
    row. Judgment: an *omitted* row is invisible to the caller except in logs — the alternative (an
    error entry in the list response) changes the contract shape. Revisit if the approver UI needs
    it.
11. Typed `PRECONDITION_FAILED` from `buildApprovalSummary`. **Clock:** resolve/expire still take
    `now` from the caller rather than DB `now()` under the lock — deliberate: the injected instant
    is what makes the lapse/race tests deterministic, and a DB clock would not remove skew between
    the tick host and the human's request anyway.

Recorded, not coded (coordinator's calls):

- **C1: nothing schedules `expireDueApprovals`, `sweepRevokedApprovals` or
  `check:stale-approvals`.** The mechanisms are built and tested; no production caller runs them, so
  an approval that lapses today stays `pending` until something calls the tick. T072, T073 and T076
  are ticked on the strength of the tested mechanism — **that tick should be reconsidered**;
  tasks.md carries the note. No scheduler was invented.
- **M4:** the decision-invalidating `updateMany` can match zero rows (already consumed or
  invalidated); silent by design (same posture as `consume()`); no warning added.
- **M5:** `Idempotency-Key` is validated for shape but not stored (the repo-wide known gap, 001
  T057); retries are safe only because each mutation is itself idempotent or guarded.
- **M6:** `check:policy-coverage` keys on `policy_action.mutating`
  (`pa.mutating = true AND pd.id IS NULL`). The approval audit actions are `mutating:false`
  deliberately: they are admin/control writes, not guarded actions; flipping them to `true` would
  make the check flag every approval audit entry (each links a non-`allow`, non-consumed decision)
  as a missing consumed ALLOW. Left as is.
