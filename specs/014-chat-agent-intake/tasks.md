# Tasks: Chat intake for agent work

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: TDD is constitutional, not optional. Every "**Test first**" task is written and watched
to fail before the task after it is started. Every guard carries a **mutation check**: break the
guard on purpose, watch the named test go red for the right reason, restore it byte for byte, and
say so in the task's done note. Where the auto-mode classifier refuses an edit to a migration,
mutate the repository or domain code instead (QUESTIONS.md "012 T093-T095" item 11).

**Organization**: one phase per stage of the spec's Stages table; inside a stage, tasks carry the
user story they serve. Stage 0 is Pavlo's, not code.

**Supersedes in 012**: T098, T102, T103, T104 are superseded by this file and are not built there.
T099 and T100 stay in 012 and are referenced, not duplicated.

## Format: `[ID] [P?] [NB?] [Story?] [human-authored?] Description`

- `[P]` — parallelisable: different files, no dependency on an unfinished task.
- `[NB]` — no behaviour change; exempt from `gate-red-first` (012 FR-056, R-14).
- `[human-authored]` — touches a protected path of 012
  [contracts/make-targets.md](../012-engineering-foundation/contracts/make-targets.md) (`specs/**/spec.md`,
  `docs/adr/**`, `docs/decisions.md`, `Makefile`, `scripts/**`, `tsconfig*.json`, `vitest.config.ts`,
  `.github/**`, `test/*.ts`, `.specify/**`, the contract itself). An agent change set touching it is
  refused by `gate-agent-scope`; a human authors it.
- **Blocked: Uxx** — waits on the named open item of [research.md](research.md) "Unresolved".

---

## Phase 1: Stage 0 — prerequisites and decisions (owner: Pavlo unless named)

No code. Each task ends in a recorded decision or a configured external thing; none commits a secret.

- [ ] T001 [NB] [human-authored] Owner Pavlo: decide U-03 — the dispatcher credential is a second GitHub App (`actions: write`, `issues: write`, `contents: read`, `metadata: read`) or a narrower installation token of the agent App; record it as the next `C-` id in `docs/decisions.md` (research R-06, FR-013, FR-031)
- [ ] T002 [NB] Owner Pavlo: create and install the GitHub App(s) per T001 on Healer's repository, after 012 T088–T092 (ruleset, `CODEOWNERS`, drift check) — the agent App's key goes into GitHub environment `agent-change` only; the dispatcher's key is held for the control plane's configuration, never committed (R-06, FR-011)
- [ ] T003 [NB] [human-authored] Owner Pavlo: decide U-05 — the project "channel" is a private Telegram supergroup (a broadcast channel carries no sender id); record in `docs/decisions.md` next to C-48 (R-07, FR-004)
- [ ] T004 [NB] Owner Pavlo: register the bot with the platform's bot registrar, create the supergroup, add the bot, note the owner's numeric user id and the chat id; keep privacy mode on until stage 3 (R-07). Values go to the control-plane host's configuration only
- [ ] T005 [NB] Owner Pavlo: a public HTTPS address for the webhook (tunnel or small host) — spec Assumptions; standing it up is not this feature's code
- [ ] T006 [NB] [human-authored] Owner Pavlo with 002's owner: decide U-01 — a work-item subject variant of 002's `DecisionInput` (issue-dependent groups absent by shape) or a 001 issue mirrored per work item first, and where the per-tenant concurrency cap lives; amend `specs/002-policy-and-autonomy/spec.md` and record in `docs/decisions.md`. **Blocks T042, T043, T085** (FR-012, R-08)
- [ ] T007 [NB] [human-authored] Owner Pavlo with 012's owner: decide U-02 — `agent.executed_in` gains `external_host`, and the fixed directive prompts are registered in the prompt registry; amend `specs/012-engineering-foundation/spec.md` and record in `docs/decisions.md`. **Blocks T065, T066** (FR-030, R-09, C-13)
- [ ] T008 [NB] [human-authored] Owner Pavlo: decide U-07 — amend 012 FR-053 and T088 so an agent pull request may name a GitHub Issue opened by the intake instead of a `tasks.md` identifier, and amend 012 spec.md's "ChatPost / ChatTask — deliberately not persisted" line to point at 014's `work_item`. **Blocks Phase 5 (stage 2)** (FR-022, R-02)
- [ ] T009 [NB] [human-authored] Owner Pavlo: decide U-06 — accept that `gate-no-send` cannot see a `fetch` to a chat platform, or ask for T093's structural check; record in `docs/decisions.md`
- [ ] T010 [NB] [human-authored] Owner Pavlo: accept or amend [ADR 0016](../../docs/adr/0016-chat-channel-agent-intake.md), C-92 (012 T097), C-96, C-97 and [ADR 0019](../../docs/adr/0019-oidc-identity-token-verification.md) (U-08); flip each to Accepted in `docs/adr/` and `docs/decisions.md`. **ADR 0019 blocks T054, T055**

---

## Phase 2: Setup

- [ ] T011 [NB] [human-authored] Land the 012 amendments drafted with this plan: FR-001 lists `intake` in `specs/012-engineering-foundation/spec.md`, the package tree in `specs/012-engineering-foundation/plan.md`, the `make intake-smoke` row in `specs/012-engineering-foundation/contracts/make-targets.md`, and the superseded / cross-reference notes on T098–T104 in `specs/012-engineering-foundation/tasks.md` (constitution Governance: the package set in 012 FR-001 is kept current)
- [ ] T012 [NB] Package skeleton `packages/domain/intake` (`@healer/domain-intake`): `package.json`, `tsconfig.json`, entry surface `src/index.ts` exporting nothing yet; `src/domain`, `src/application/commands`, `src/infrastructure` per [plan.md](plan.md)
- [ ] T013 [NB] [human-authored] Add `packages/domain/intake` to the root `tsconfig.json` project references; add `@healer/domain-intake` to `apps/api` and `apps/worker` `package.json` dependencies and their `tsconfig.json` references (C-89: no phantom dependency)
- [ ] T014 [P] **Test first** `packages/shared/src/config/config.test.ts`: intake configuration absent → `intake` is `undefined`; present with an empty `allowlist` → `loadConfig` throws `ConfigurationError`; `cardTtlMinutes` above 60 is refused; the bot token, webhook secret and dispatcher key never appear in the presence-only diagnostic or in a thrown message (FR-004, FR-031, R-11, R-12). Mutation check: drop the allowlist's `.min(1)` → red
- [ ] T015 Intake configuration in `packages/shared/src/config/index.ts`: `INTAKE_CHANNELS` parsed and validated per [contracts/channel-port.md](contracts/channel-port.md) "Channel configuration" (`channelKey`, `tenantId`, `platform`, `chatId`, `botUsername`, secret, bot token, non-empty `allowlist`, executor binding `repositoryId` and workflow refs, `cardTtlMinutes` ≤ 60, default 15); each secret's description names the 012 T066 debt (R-11)

---

## Phase 3: Foundational (blocks every stage)

- [ ] T016 **Test first** `prisma/migration.e2e.test.ts` (new `describe` for 014) against a real Postgres: each unsafe row is refused by the database — a second `work_job` with `ended_at IS NULL` for one work item; a `read_only` job with `outcome = 'pull_request'`; a `branch_and_pull_request` job with `outcome = 'found'`; one `host_run_id` on two jobs; a `report` row with a `card_*` column set; a `card` row missing one; a `work_item` in `failed` with no `reason_code`; a `task_ref` not matching `T\d{3,4}` or on a kind other than `task`; a second non-terminal item for one `task_ref`; a foreign tenant through every composite foreign key; and `down.sql` then `migration.sql` round-trips (data-model.md; FR-015, SC-006). Mutation check: delete each constraint in a scratch copy of the migration and watch its case go red; where the classifier refuses the edit, record that and rely on the per-constraint insert tests
- [ ] T017 Migration `prisma/migrations/20261009000000_014_intake_core/migration.sql` and `down.sql`, and `prisma/schema.prisma` (`"intake"` in the datasource `schemas`; models `WorkItem`, `WorkJob`, `ChatMessageRef`, `ChatUpdateSeen`; enums `work_item_kind`, `work_item_state`, `job_grant`, `job_outcome`, `message_purpose`, `update_disposition`) exactly as [data-model.md](data-model.md); update `data-model.md` in the same change for anything that changed (`gate-data-model`). Re-check `ls prisma/migrations` and `git fetch` for a newer prefix first. `description` is "≤ 4000 characters"; `reason_code` is text validated by the domain, not an enum
- [ ] T018 [P] **Test first** `packages/domain/intake/src/domain/reason-codes.test.ts`: parses the fenced block of [contracts/reason-codes.md](contracts/reason-codes.md) and asserts `REASON_CODES` equals it, in both directions (FR-028). Mutation check: add a code only in TypeScript → red
- [ ] T019 [P] `packages/domain/intake/src/domain/reason-codes.ts`: `REASON_CODES` and `ReasonCode`, plus `isShownInChannel(code)` from the contract's second column
- [ ] T020 [P] **Test first** `packages/domain/intake/src/domain/state-machine.test.ts`: reads the "State graph" table of [data-model.md](data-model.md) and asserts every listed edge is allowed and every other pair throws `InvalidWorkItemTransitionError`; initial state per kind (`investigate` → `confirmed`, `fix`/`task` → `awaiting_confirmation`, `finding` → `reported`); a terminal state has no edge out; `failed`/`stopped`/`cancelled`/`expired` refuse to be entered without a reason code; every transition returns the event with cause and actor (FR-021). Mutation check: add one undeclared edge → red
- [ ] T021 `packages/domain/intake/src/domain/state-machine.ts` and `work-item.ts`: the graph as a closed `Record<WorkItemState, readonly WorkItemState[]>`, `transitionWorkItem`, `initialState(kind)`; string unions for kind, state, grant and outcome mirrored from Prisma with a closed-lists test pinned to the enums (the `issue-enums.ts` convention)
- [ ] T022 [P] [NB] Ports in `packages/domain/intake/src/domain/`: `chat-channel.ts`, `agent-executor.ts` (with `CallbackVerifier`), `work-ledger.ts`, `dispatch-policy.ts`, `signal-intake.ts` — types only, exactly as [contracts/channel-port.md](contracts/channel-port.md), [contracts/executor-port.md](contracts/executor-port.md), [contracts/work-ledger-port.md](contracts/work-ledger-port.md)
- [ ] T023 [P] **Test first** `packages/domain/intake/src/domain/job-event.test.ts`: the callback body schema refuses a step outside the closed vocabulary, an `outcome` outside the grant's set, a missing field for the outcome (`pull_request` without `pullRequest`, `needs_decision` without `draft` and `question`), a finding claim over 500 characters, more than 20 findings, `seq` < 1, and any extra key (FR-016, FR-026, FR-027). Mutation check: remove `.strict()` → red
- [ ] T024 [P] `packages/domain/intake/src/domain/job-event.ts`: zod schemas for `started`, `step`, `ended` and both report shapes per [contracts/executor-port.md](contracts/executor-port.md); `STEPS` is that contract's step list
- [ ] T025 **Test first** `packages/domain/intake/src/infrastructure/prisma-work-item-repository.e2e.test.ts`: a transition writes its `audit_entry` in the same transaction (a forced rollback leaves neither); two transitions validated against the same state — the second, held behind an open transaction and observed waiting in `pg_stat_activity`, loses with `ConcurrentModificationError`, never by sleeping; every query is tenant-scoped (another tenant's id finds nothing) (FR-018, FR-023). Mutation check: drop the `WHERE state = …` guard → red
- [ ] T026 Prisma repositories in `packages/domain/intake/src/infrastructure/` (`prisma-work-item-repository.ts`, `prisma-work-job-repository.ts`, `prisma-chat-message-repository.ts`, `prisma-update-seen-repository.ts`) and `record-intake-audit-entry.ts` (writes `audit.audit_entry` inside the caller's transaction, actor `human` with `requester_ref`, `system`, or `agent`); concurrency translation via `@healer/prisma-client`'s helper as `prisma-concurrency.ts` does
- [ ] T027 [P] **Test first** in `packages/domain/policy/src/domain/policy-action-repository.test.ts`: the seven intake keys of [data-model.md](data-model.md) "Registrations" exist with owning spec `014` — `intake.dispatch_investigation` (`read_only`, `mutating: false`), `intake.dispatch_change` (`code_change`, `mutating: true`), and `intake.create_work_item`, `intake.refuse`, `intake.confirm_card`, `intake.cancel`, `intake.job_event` (`mutating: false`); `check:policy-coverage` stays green with intake audit rows. Mutation check: remove one key → red
- [ ] T028 [P] Register the seven keys in `SEED_POLICY_ACTIONS` (`packages/domain/policy/src/domain/policy-action-repository.ts`)
- [ ] T029 **Test first** `apps/api/src/intake/intake-module.e2e.test.ts`: with no intake configuration the intake routes are not mounted (404); with an empty allowlist the API refuses to start (FR-004, spec edge case). Mutation check: mount the module unconditionally → red
- [ ] T030 `apps/api/src/intake/intake.module.ts` wired into `createApiModule` only when configuration is present; ports bound to adapters by constructor arguments (R-14)

**Checkpoint**: schema, state graph, reason codes, ports and repositories exist; nothing is reachable from a chat yet.

---

## Phase 4: Stage 1 — MVP: `/investigate`, in-place report, `/status`, `/cancel`, `make intake-smoke`

**Independent test**: quickstart 1–4, 6–8, 17–22, 25–27; the full path is `make intake-smoke`.
**Blocked**: dispatch on U-01 (T042–T043), cost landing on U-02 (T065–T066), the real verifier on
U-08 (T054–T055), isolation tests on U-04 (T036, then T038, T053).

### Classification and the webhook (US1, US2)

- [ ] T031 [P] [US1] **Test first** `packages/domain/intake/src/domain/classify.test.ts`: the classification order of [contracts/command-grammar.md](contracts/command-grammar.md) — button, reply, command at offset 0, finding, unclassified; `/investigate@OtherBot` is `ignored`; a pasted log containing `/fix #1` mid-text is a finding, not a command; every command's argument rule (`<text>` 1..4000 characters, `<short id>` 8 hex); unknown command and bad argument carry `unknown_command` / `argument_invalid`; the classifier never reads the text beyond the entity's offset and the argument split (FR-001, R-15). Mutation check: match `/fix` anywhere in the text → red
- [ ] T032 [P] [US1] `packages/domain/intake/src/domain/classify.ts` and `command-grammar.ts`, pure functions of `ChannelEvent`
- [ ] T033 [P] [US2] **Test first** `packages/integrations/src/telegram/telegram-channel.test.ts` on recorded update fixtures: missing or wrong `X-Telegram-Bot-Api-Secret-Token` → `rejected`, compared in constant time; each fixture parses to its kind; `edited_message`, `channel_post` and another bot's command → `ignored` with the closed `why`; `forward_origin` or `from.is_bot` → `finding`; `senderId` is `telegram:<from.id>`; unknown shapes are `ignored`, never thrown (FR-001, FR-005, R-07). Mutation check: replace the constant-time comparison with `===` on a prefix → red
- [ ] T034 [US2] `packages/integrations/src/telegram/telegram-channel.ts`: `authenticate` and `parse`, pure functions of headers and body (no SDK, R-07)
- [ ] T035 [US2] **Test first** `apps/api/src/intake/channel-updates.e2e.test.ts` (quickstart 6, 7, 8): wrong secret → 404, no row, `intake_webhook_rejected{reason=secret}` +1; right secret, foreign chat → 200, no row, counter `{reason=chat}` +1; the same `update_id` twice → one `chat_update_seen`, one work item; a non-allowlisted sender → no work item, no send on the fake channel, one `audit_entry` `intake.refuse` / `sender_not_allowlisted` naming `telegram:<id>`; the tenant is the channel configuration's and a `tenantId` in the body is ignored (FR-004..FR-008, SC-001, SC-005). Mutation check for each guard: skip `authenticate`, skip the chat check, drop `ON CONFLICT DO NOTHING`, skip the allowlist — each turns its case red
- [ ] T036 [US2] [human-authored] Extend `test/tenant-isolation.ts`: an optional `headersForTenant(tenantId)` on `assertTenantIsolated` and `assertTenantScopedEnqueue` for routes authenticated by a per-tenant credential rather than a tenant header; the existing calls are unchanged and `gate-isolation`'s call pattern still matches (R-13, SC-009). **Blocked: U-04** (needs a human author)
- [ ] T037 [US2] `apps/api/src/intake/channel-updates.controller.ts` (`POST /api/v1/intake/channels/:channelKey/updates`, thin) and `packages/domain/intake/src/application/commands/handle-update.ts`: authenticate → parse → chat check → insert `chat_update_seen` → allowlist → classify → act, one transaction; sends and renders enqueued after commit; no outbound call in the request ([contracts/channel-port.md](contracts/channel-port.md))
- [ ] T038 [US2] Tenant-isolation e2e in `apps/api/src/intake/channel-updates.e2e.test.ts` calling `assertTenantScopedEnqueue(app, 'POST', '/api/v1/intake/channels/:channelKey/updates', …)` with tenant B's channel secret against tenant A's channel key → 404, nothing written (SC-009). Depends on T036

### `/investigate` to dispatch (US1, US2)

- [ ] T039 [US1] **Test first** `packages/domain/intake/src/application/commands/handle-update.test.ts`: `/investigate <text>` from the owner creates one `investigate` work item in `confirmed` with `description` = the argument, `content_hash` over the canonical card content, one audit entry `intake.create_work_item`, and enqueues one dispatch job; no card is created (US1 AS1, FR-009). Mutation check: create it in `awaiting_confirmation` → red
- [ ] T040 [P] [US2] **Test first** `packages/domain/intake/src/domain/directive.test.ts` (SC-002, quickstart 9 for the investigate path): for every fixture in an injection corpus (instructions to edit `CODEOWNERS`, change the budget, add a label, swap the prompt, close the data block's delimiter), the built `Directive` equals the control post's in `promptVersionId`, `taskRef`, `ledgerRef`, `grant`, `budget` and `callbackUrl`, and differs only in `description`; the description is one delimited block and its delimiter cannot be closed from inside (FR-002). Mutation check: interpolate the description into the prompt id → red
- [ ] T041 [P] [US2] `packages/domain/intake/src/domain/directive.ts`: `buildDirective(workItem, job, prompts)` from typed fields only; refuses kind `finding` (FR-003, [contracts/executor-port.md](contracts/executor-port.md) "Directive")
- [ ] T042 [US1] **Test first** `packages/domain/intake/src/application/commands/dispatch-job.test.ts`: policy `allow` → one `work_job` (`attempt` 1, grant `read_only`, `policy_decision_id`, `deadline_at` = now + 20 min + 10 min grace), the work item `running`, `executor.dispatch` called once with the investigation workflow; `deny` → `failed(policy_denied)` with 002's code in `policy_reason_code`, no dispatch; the per-tenant running-job cap (2) → `failed(concurrency_cap)`; a second dispatch for the same work item is refused by the partial unique index, never by a read; a host 4xx → `failed(dispatch_failed)` at once, a 5xx → retried by BullMQ then `failed(dispatch_failed)` on the last attempt with the owner told (US1 AS1, US4 AS1, FR-012..FR-015). Mutation check: dispatch before `allow` is checked → red. **Blocked: U-01** for the real `DispatchPolicy`; written against the port
- [ ] T043 [US1] `packages/domain/intake/src/application/commands/dispatch-job.ts` and the `execution`-queue processor in `apps/worker/src/intake/dispatch.processor.ts`; `DispatchPolicy` wired to 002's `evaluateAndBind` in `apps/worker` with action `intake.dispatch_investigation` and `declaredMaxCost` = the spend cap (R-08). **Blocked: U-01**
- [ ] T044 [P] [US1] **Test first** `packages/integrations/src/github/github-executor.test.ts` against a recorded fixture server: `dispatch` with grant `read_only` posts `workflow_dispatch` to `agent-investigate.yml` and with `branch_and_pull_request` to `agent-task.yml`, never the other; the description is one input; a 4xx is `refused_by_host`, a 5xx or network error `unavailable`; a run id in the response is bound; `cancel` on an ended run is `already_ended` (FR-013, FR-016, R-01, R-06). Mutation check: choose the workflow from the directive's description → red
- [ ] T045 [P] [US1] `packages/integrations/src/github/github-executor.ts` and `github-app-token.ts` (dispatcher installation token, minted per call, never logged), using `fetch`
- [ ] T046 [US1] [human-authored] `.github/workflows/agent-investigate.yml`: `workflow_dispatch` with the directive's inputs; `permissions: contents: read, issues: read, pull-requests: read, actions: read, id-token: write` and nothing else; environment `agent-investigate` (model key with its own spend limit), never `agent-change`; `timeout-minutes: 20`; deterministic steps post `started`, `step` and `ended` to the callback with a fresh OIDC token for the configured audience; the description is written to a file, never expanded in a shell; the last step validates the agent's report file against the `ended` schema before posting (R-06, FR-013, FR-014, SC-006)
- [ ] T047 [US1] **Test first** (after T046) `apps/worker/src/intake/deadline-constants.test.ts`: reads `timeout-minutes` from `.github/workflows/agent-investigate.yml` (and `agent-task.yml` once it exists) and asserts the control plane's wall-clock constants equal them and stay within the clamps of R-12 (≤ 60 and ≤ 180 minutes). Mutation check: change one literal → red

### The callback (US1, US4)

- [ ] T048 [P] [US4] **Test first** `packages/domain/intake/src/application/commands/apply-job-event.test.ts`: binding — claims from another repository, another run, `run_attempt` 2, the other workflow, or `event_name` ≠ `workflow_dispatch` are refused and audited `callback_refused`; an unbound job is bound by the first `started` and a second `started` for another run is refused; application — `seq ≤ last_event_seq` is `applied: false`; an event after `ended_at` is `applied: false`; `ended` transitions the work item along the graph with the outcome; a `stopped` outcome carries `budget_exhausted` (US4 AS3, AS4, AS6, FR-017, FR-018, R-04). Mutation check: compare `repositoryId` by name instead of id; drop the `seq` guard — each red
- [ ] T049 [US4] `packages/domain/intake/src/application/commands/apply-job-event.ts`: binding check per research R-04's table, one guarded update over `work_job` and `work_item` per event, audit `intake.job_event`
- [ ] T050 [P] [US4] Fake `CallbackVerifier` in `packages/integrations/src/test-support/fake-callback-verifier.ts` signing and verifying with a local key, for e2e and smoke (R-14)
- [ ] T051 [US4] **Test first** `apps/api/src/intake/job-events.e2e.test.ts` (quickstart 19, 20): bad signature → 401, logged and counted, no audit row; a verified token of an unconfigured repository → 404; another run / attempt / workflow → 403 and audited; duplicate and stale `seq` → 200 `{ applied: false }`; an `ended` failing the schema → 422 and `report_invalid` (US4 AS3, AS4). Mutation check: skip the binding check → red
- [ ] T052 [US4] `apps/api/src/intake/job-events.controller.ts` (`POST /api/v1/intake/jobs/:jobId/events`, thin): verify → tenant from configuration by `repositoryId` → load job under that tenant → apply ([contracts/executor-port.md](contracts/executor-port.md) "Callback route")
- [ ] T053 [US4] Tenant-isolation e2e in `apps/api/src/intake/job-events.e2e.test.ts` calling `assertTenantIsolated(app, 'POST', '/api/v1/intake/jobs/:jobId/events', …)`: tenant B's verified token against tenant A's job → 404, nothing changes (SC-009). Depends on T036
- [ ] T054 [US4] **Test first** `packages/integrations/src/github/github-oidc-verifier.test.ts` with `createLocalJWKSet`: wrong issuer, wrong audience, expired, `alg: none`, HS256 signed with the public key, unknown `kid`, missing required claim — each refused; the issuer is a literal and cannot be configured (ADR 0019, FR-017). Mutation check: accept any algorithm → red. **Blocked: U-08** (ADR 0019 accepted)
- [ ] T055 [US4] [human-authored] `packages/integrations/src/github/github-oidc-verifier.ts` with `jose` (exact version, `algorithms: ['RS256']`, clock tolerance 60 s) and the `deps-check` allowlist entry (`scripts/gates/deps-check.mjs`); the constitution's dependency note in `.specify/memory/constitution.md` and ADR 0019's status in `docs/adr/` change in the same change set (`deps-check` requires a changed ADR naming the package). **Blocked: U-08**

### Reports (US1, US4)

- [ ] T056 [P] [US1] **Test first** `packages/domain/intake/src/domain/report.test.ts` (quickstart 3): a finding with no ref, or with refs that `resolveRef` reports absent, is dropped and counted in `findings_withheld`; a shown finding always has at least one resolving ref; the verdict is one of `found`, `not_found`, `inconclusive`; `inconclusive` with no findings is complete and offers "widen" (US1 AS3, AS4, FR-026, SC-008). Mutation check: show a finding when `resolveRef` is false → red
- [ ] T057 [P] [US1] `packages/domain/intake/src/domain/report.ts`: validation and resolution through `WorkLedger.resolveRef`
- [ ] T058 [P] [US1] **Test first** `packages/integrations/src/github/github-ledger.test.ts` (read part, recorded fixture server): `resolveRef` is `false` for a file absent at the cited commit and for a run, issue or pull request of another repository; `readTask` and `findIssue` per [contracts/work-ledger-port.md](contracts/work-ledger-port.md). Mutation check: skip the repository comparison → red
- [ ] T059 [P] [US1] `packages/integrations/src/github/github-ledger.ts` — `resolveRef`, `findIssue`, `readTask`, `comment` (no write to file contents exists on the type)
- [ ] T060 [P] [NB] [US4] Lift the runner's `private_key_block`, `connection_string` and `bearer_token` detectors from `apps/runner/src/collection/redaction/detectors.ts` into a package both the runner and the control plane import (`packages/boundary-contract/src/detectors.ts`), moving their existing tests with them; the runner's behaviour is unchanged (R-10)
- [ ] T061 [US4] **Test first** `packages/domain/intake/src/domain/render.test.ts` (quickstart 2, 21): a render contains kind and link, current step, elapsed time against the wall-clock budget, spend against cap only when reported and labelled "reported", and links to run, pull request and audit; text never exceeds `limits.maxTextLength` and overflow is marked for the ledger comment; a planted secret and a planted source line in a finding claim withhold the body with `report_withheld_secret` and leave the work item's state unchanged (FR-024, FR-025, FR-030). Mutation check: skip the secret scan → red
- [ ] T062 [US4] `packages/domain/intake/src/domain/render.ts`
- [ ] T063 [US4] **Test first** `apps/worker/src/intake/render.processor.e2e.test.ts` (quickstart 2, 21): three transitions in a burst produce one send and at most one edit with the latest version (`jobId` `intake-render__<id>__<version>`, 1.5 s delay, no-op when `rendered_version` is current); `unchanged` is success; `rate_limited` re-queues after `retry_after`; `failed` sets `last_failure = channel_unavailable` and leaves `work_item` untouched; `gone` sends a new message; overflow is posted as one ledger comment (US1 AS2, US4 AS5, FR-024, FR-029). Mutation check: render the job's version instead of the current one → red
- [ ] T064 [US4] `packages/domain/intake/src/application/commands/render-message.ts`, `apps/worker/src/intake/render.processor.ts` on the `scheduling` queue, and `send`/`edit`/`answerButton` in `packages/integrations/src/telegram/telegram-channel.ts`
- [ ] T065 [US4] **Test first** `packages/domain/intake/src/application/commands/record-job-cost.test.ts` (quickstart 22): an `ended` with a reported cost writes one `agent_run` (`agent_kind` `investigator` or `change`, `executed_in = external_host`, `cost_provenance = reported`, `policy_decision_id` the dispatch decision, `correlation_id` the work item's) and links it on `work_job.agent_run_id`; a redelivered `ended` writes nothing new (FR-030, C-95, SC-005). Mutation check: write `estimated` → red. **Blocked: U-02**
- [ ] T066 [US4] `record-job-cost.ts` and the `external_host` migration of `agent.executed_in` (new migration, its own `down.sql`, and 012 `data-model.md` updated in the same task). **Blocked: U-02**

### `/status`, `/cancel`, `/help`, unclassified posts (US1, US4)

- [ ] T067 [P] [US4] **Test first** `packages/domain/intake/src/application/commands/status.test.ts`: `/status` answers the requester's non-terminal items and last five terminal ones from the database, including after every send has failed; `/status <short id>` of another requester's item answers nothing more than "not found" (FR-029, US4 AS5). Mutation check: read from the last render → red
- [ ] T068 [P] [US4] `packages/domain/intake/src/application/commands/status.ts`
- [ ] T069 [P] [US4] **Test first** `packages/domain/intake/src/application/commands/cancel.test.ts`: `/cancel` moves the requester's own running item to `cancelled(cancelled_by_owner)` and enqueues `executor.cancel`; another requester's item is `nothing_to_cancel`; two own items → `argument_invalid` listing both; a repeat is idempotent (FR-032, SC-005). Mutation check: skip the requester comparison → red
- [ ] T070 [P] [US4] `packages/domain/intake/src/application/commands/cancel.ts` and the cancel processor in `apps/worker/src/intake/cancel.processor.ts`
- [ ] T071 [P] [US1] `/help` rendered from [contracts/command-grammar.md](contracts/command-grammar.md)'s command table, and the unclassified-post reply with choice buttons `u:<id>:i` (investigate) — `u:<id>:f` waits for stage 3; **test first** that an unclassified post creates no work item and dispatches nothing (FR-001). Mutation check: dispatch on an unclassified post → red
- [ ] T072 [US1] "Widen" button (`w:<id>`) on an `inconclusive` report: a new `investigate` item with `parent_id`, at the next budget tier; **test first** that it requires the original requester and an `inconclusive` parent (US1 AS4). Mutation check: allow it on `found` → red

### The deadline sweep (US4)

- [ ] T073 [US4] **Test first** `apps/worker/src/intake/intake-deadlines.e2e.test.ts` (quickstart 18): with the clock past `deadline_at`, one sweep run moves the item to `failed(timeout)` and enqueues exactly one cancel; a second run changes nothing; a `confirmed` item with no job older than one interval gets its dispatch re-enqueued; a message whose `rendered_version` trails gets a render re-enqueued; an expired card (stage 2 data) moves to `expired`; another tenant's rows are untouched (US4 AS2, FR-019, SC-004, R-05). Mutation check: drop `ended_at IS NULL` from the timeout query → red
- [ ] T074 [US4] Add `'intake-deadlines': { queue: 'scheduling', everyMs: 60_000 }` to `TENANT_SWEEPS` in `packages/workflow/src/schedule/tenant-sweep.ts` and its body to `apps/worker/src/main.ts`'s `sweepBodies` (a missing body does not compile), calling `packages/domain/intake/src/application/commands/sweep-deadlines.ts` (ADR 0018)

### Contract suites (US6)

- [ ] T075 [P] [US6] Channel contract suite `packages/domain/intake/src/test-support/chat-channel.contract.ts` per [contracts/channel-port.md](contracts/channel-port.md) "Contract suite", plus a fake adapter `fake-chat-channel.ts`; a test asserts the suite's source names no product (US6 AS1)
- [ ] T076 [P] [US6] Run the channel suite against the Telegram adapter with a recorded fixture server in `packages/integrations/src/telegram/telegram-channel.contract.test.ts` (quickstart 25)
- [ ] T077 [P] [US6] Executor contract suite `packages/domain/intake/src/test-support/agent-executor.contract.ts` per [contracts/executor-port.md](contracts/executor-port.md) "Contract suite", plus `fake-agent-executor.ts`; no product named (US6 AS2)
- [ ] T078 [P] [US6] Run the executor suite against the GitHub Actions adapter in `packages/integrations/src/github/github-executor.contract.test.ts` (quickstart 26)

### The smoke target (US7)

- [ ] T079 [US7] [human-authored] **Test first**: `scripts/smoke/intake-smoke.mjs` — the target's contract in [quickstart.md](quickstart.md) and 012 make-targets: in-process API and worker, disposable Postgres and Redis, fake chat server and fake host by constructor argument, `/investigate` → `started`, two `step`s, a cited `ended found`; passes only on one report message whose last edit is the terminal verdict within 60 s. Watch it fail on a tree with the callback route unmounted, then with the allowlist emptied (fails at start), then with the render processor disabled (SC-007, US7)
- [ ] T080 [US7] [human-authored] `Makefile`: `intake-smoke` target with a `##` description, added to `.PHONY`; not in `ci` (see T102)

**Checkpoint (MVP)**: quickstart 1–4, 6–8, 17–22, 25–27 pass; `make intake-smoke` is green; `make ci`
is green.

---

## Phase 5: Stage 2 — `/fix` and `/task` with a card (US3, US2)

**Independent test**: quickstart 5, 9–16. **Blocked**: T008 (U-07), 012 T089 and T097.

- [ ] T081 [US3] **Test first** `packages/domain/intake/src/application/commands/handle-update.fix-task.test.ts` (quickstart 12): `/fix #123` takes the issue (`issue_not_found` if absent); `/fix <text>` creates one issue labelled `bug`; `/task T042` reads the line on the default branch (`task_not_found`, `task_done`, `task_in_flight`) and takes or creates the open `agent-task` issue naming it; `/task <text>` creates one `agent-task` issue; each yields a work item in `awaiting_confirmation` with `ledger_ref` set and one card, and dispatches nothing; a second `/fix` on an issue with a non-terminal item is `work_item_busy` (US3 AS1, FR-009, FR-015, FR-022). Mutation check: dispatch on `/fix` → red
- [ ] T082 [US3] `findIssue`/`createIssue` in `packages/integrations/src/github/github-ledger.ts` (one label from the closed list; titles and bodies built from typed fields with the post as a quoted, scanned data block) and the `/fix`, `/task` branches of `handle-update.ts`
- [ ] T083 [US2] **Test first** `packages/domain/intake/src/domain/card.test.ts` (quickstart 10, 11): the card id is 16 random bytes, base64url, stored only as SHA-256; confirmation is refused with `card_wrong_account`, `card_content_changed`, `card_used`, `card_expired`, each audited; a second confirmation is idempotent and creates no second job; a confirmation after `/cancel` creates no job (US2 AS5, AS6, FR-010, SC-003, SC-005). Mutation check: compare the content hash after marking the card used → red; skip the account comparison → red
- [ ] T084 [US2] `packages/domain/intake/src/domain/card.ts` and `application/commands/confirm-card.ts` (the `c:` and `x:` buttons): card checks, then `confirmed`, then the dispatch job — all in one transaction with `card_used_at`
- [ ] T085 [US3] **Test first** in `dispatch-job.test.ts` for the change path (quickstart 13, 14): a confirmed `fix`/`task` evaluates `intake.dispatch_change`; only `allow` dispatches a `branch_and_pull_request` job to `agent-task.yml`; `deny` shows the closed reason and 002's code on the card; no job holds merge, approval or administration (US3 AS2, AS3, FR-011, FR-012, SC-003, SC-006). Mutation check: dispatch on `require_approval` → red. **Blocked: U-01**
- [ ] T086 [US3] [human-authored] `.github/workflows/agent-task.yml` (built by 012 T089): accept the intake's directive inputs (`ledgerRef` alongside `TASK_ID`), `id-token: write`, environment `agent-change`, `timeout-minutes: 60`, the same deterministic callback steps as T046; App token `contents: write, pull-requests: write, issues: write`, no administration (R-06, FR-013). Depends on 012 T089, T097
- [ ] T087 [US3] **Test first** in `apply-job-event.test.ts` and `render.test.ts` (quickstart 15, 16): `ended` with `pull_request`, `needs_decision` (question and draft link shown) and `stopped` (branch and breach) each renders its link; any other outcome for this grant is 422 (US3 AS4, AS5 display only, FR-027). Mutation check: accept `found` on a change job → red
- [ ] T088 [US3] The change-outcome branches of `apply-job-event.ts` and `render.ts`
- [ ] T089 [US1] "Open issue" button (`i:<id>`) on an investigation report: one issue labelled `bug` from the report (digests and links only) and a `fix` card; nothing starts by itself; **test first** (quickstart 5, US1 AS5). Mutation check: dispatch without the card → red

---

## Phase 6: Stage 3 — findings, follow-up loop, replies (US5, US3)

**Independent test**: quickstart 23, 24, 16 (reply part). **Blocked**: stage 2; 012 T100's answer.

- [ ] T090 [NB] [human-authored] Owner Pavlo with 001's owner: decide how a finding maps onto 001's `Signal` — `component`, `environment` and `errorSignature` are required there and a paste carries none of them — and record it in `docs/decisions.md` and 001's spec (plan.md "Stages")
- [ ] T091 [US5] **Test first** `packages/domain/intake/src/application/commands/handle-finding.test.ts` (quickstart 23, 24): a forwarded log and a bot post each produce one signal through the `SignalIntake` port with the update id as delivery id and the sender as producer, one `finding` work item created in `reported`, and no job; a redelivered update produces one signal; the "investigate" button (`f:<id>`) creates a new `investigate` item; text in the paste imitating a command does nothing (US5 AS1, AS2, FR-003, 001 FR-004). Mutation check: dispatch a finding → red
- [ ] T092 [US5] `handle-finding.ts`; `SignalIntake` wired in `apps/api` to 001's ingest command; `u:<id>:f` enabled; the ledger issue labelled `finding`
- [ ] T093 [US3] Follow-up loop: a reply to a `needs_decision` report continues the same work item — adds the edge out of `reported` to `data-model.md`'s graph in the same change, consumes 012 T100's re-dispatch rule, same budgets, never an App approval or merge; **test first** that a reply from a non-owner or to another message does nothing (US3 AS5, FR-027). Blocked on 012 T100
- [ ] T094 [NB] [US5] Runbook addition in `docs/runbooks/chat-channel.md` (T100): privacy mode off, or the bot an administrator, so pasted findings reach it (R-07)

---

## Phase 7: Stage 4 — Slack, the Healer-issue mirror, other executors (US6) — tracked

- [ ] T095 [US6] [human-authored] Slack `ChatChannel` adapter in `packages/integrations/src/slack/`, passing the channel contract suite; an ADR naming its SDK if one is used, and the `EGRESS_ALLOWLIST` entry in `scripts/gates/no-send.mjs` (US6, FR-020's channel twin)
- [ ] T096 [US6] A `WorkLedger` adapter mirroring work items into Healer issues on Healer's own tenant (012 T101), passing the ledger suite. Waits for 006–008 and the GitHub VCS adapter
- [ ] T097 [P] [US6] A self-hosted worker `AgentExecutor`, passing the executor suite (FR-020)
- [ ] T098 [P] [US6] Healer's own runner as an `AgentExecutor` (ADR 0010), passing the executor suite; needs 012 T093's real `runAgent`
- [ ] T099 [US6] The product pipeline (006–008) as an `AgentExecutor` adapter under `packages/integrations/src/` for customer incidents (C-96), passing the executor suite

---

## Phase 8: Polish

- [ ] T100 [P] [NB] Runbook `docs/runbooks/chat-channel.md`, indexed in `docs/README.md` (supersedes 012 T104): register the bot and the webhook with its secret; set and rotate the allowlist; set the starting budgets of R-12 through 002's budget API; rotate the bot token, webhook secret and dispatcher key by hand (012 T066 debt); `/cancel`; what to do when the channel is compromised — revoke the bot token first, then the dispatcher token (FR-032)
- [ ] T101 [P] [NB] [human-authored] If T009 asks for it: a structural check that only `packages/integrations/src/{telegram,slack}` names a chat platform's API host, in `scripts/gates/no-send.mjs` with its failing fixture first (U-06)
- [ ] T102 [NB] [human-authored] Add `intake-smoke` to `make ci` in `Makefile` and to the `make ci` composition of 012 `contracts/make-targets.md`, once it is green on a clean checkout
- [ ] T103 [P] [NB] `docs/changelog.md` and `VERSION` for each stage that lands; `docs/roadmap.md` 014 row updated (tasks ✅)
- [ ] T104 [NB] Run `make ci`, `make intake-smoke` and quickstart 1–27; tick the tasks; fold resolved U-items from QUESTIONS.md into `docs/decisions.md`

---

## Dependencies

```text
Stage 0 (T001–T010, Pavlo) ──────────────────────────────────────────────┐ unblocks
Setup (T011–T015) → Foundational (T016–T030) → Stage 1 (T031–T080) → Stage 2 (T081–T089)
                                                                   → Stage 3 (T090–T094) → Stage 4 (T095–T099)
Polish (T100–T104) after the stage it documents
```

- Blocked on Pavlo: T001–T010 themselves, and through them T036/T038/T053 (U-04), T042/T043/T085
  (U-01), T054/T055 (U-08), T065/T066 (U-02), all of Phase 5 (U-07, 012 T089, T097), T090, T093
  (012 T100), T101 (U-06).
- Inside Stage 1: T031–T032 before T037; T033–T034 before T035–T037; T036 before T038 and T053;
  T040–T041 before T042; T044–T046 before T042's e2e; T048–T050 before T051–T053; T056–T064 before
  T079; T073–T074 after T042.
- Every "**Test first**" task precedes the task after it.

## Parallel groups

- Foundational: T018–T019, T020, T022, T023–T024, T027–T028 together after T017.
- Stage 1: T031, T033, T040, T044, T048, T050, T056, T058, T060, T067, T069, T075, T077 can start
  together once Foundational is done; T076 and T078 after their adapters.
- Stage 4: T097 and T098.

## Strategy

1. **MVP is Stage 1**: `/investigate` from the owner, a read-only job, one message edited to a cited
   verdict, `/status`, `/cancel`, and `make intake-smoke` guarding the path. It carries no risk of a
   change landing and exercises every seam.
2. **Do not ship Stage 1 around a blocker.** U-01 (what policy evaluates) and U-02 (where cost lands)
   decide whether a dispatch is governed and its spend counted; building past them with filler values
   would be a claim nothing checked (plan.md, Constitution Check).
3. **Stage 2 only after 012's agent gates are live** (T088–T092) and FR-053 accepts an intake issue
   (U-07); otherwise every intake pull request is refused by `gate-agent-scope`.
4. Small commits: each test-first task and its implementation land together; `[human-authored]`
   tasks are committed by Pavlo.
