# Phase 0 Research: chat intake for agent work

Each entry is a decision, why it was taken, and what was rejected. Items that need Pavlo or another
spec's owner are collected under [Unresolved](#unresolved); nothing below silently assumes their
answer.

## R-01 · The GitHub Actions executor comes first

**Decision**: the first `AgentExecutor` implementation dispatches a GitHub Actions workflow in
Healer's own repository through the REST `workflow_dispatch` endpoint, cancels through the run's
`cancel` endpoint, and receives status only through the signed callback of R-04. The agent inside
the job is the Claude Code action (C-92, 012 T097).

**Rationale**: 012 R-16 and ADR 0011 already put Healer's development agents in GitHub Actions — the
job's fresh checkout is the worktree, `timeout-minutes` is the wall-clock stop, the model key's own
limit is the spend stop, the ruleset holds merge. Every control FR-013, FR-014 and FR-011 need is a
host or provider setting the prompt cannot reach. Dispatching there adds one REST call and one
callback route; it adds no runtime to operate. Healer's own source stays in the job (ADR 0010: the
model call runs where its input lives); the control plane receives digests, identifiers and links.

**Alternatives**: a self-hosted worker (a machine to operate before the first useful run; later, as
a second implementation of the same contract, FR-020); Healer's own runner (needs 012 T093's real
`runAgent` and 006–008, stage 4); calling the model from the control plane (puts repository content
in the control plane, ADR 0010).

## R-02 · A GitHub Issue is the work item's ledger; `work_item` holds only intake state

**Decision**: a work item of kind `fix`, `task` or `finding` is backed by a GitHub Issue, created or
taken through the `WorkLedger` port ([contracts/work-ledger-port.md](contracts/work-ledger-port.md)).
A planned task is addressed by its `tasks.md` identifier and is never written (FR-022). The
`work_item` table holds what the issue cannot: the closed state, the card binding, the content hash
the card was confirmed against, the jobs, and the message identifiers — the intake's own state
machine, not a copy of the task.

**Rationale**: the issue is where a human reads, comments, links the pull request and closes; it
outlives any chat history; 012 FR-061 already named "a task line or tracked issue". The state that
decides whether a job may start must sit in Postgres under a transaction, a guarded update and a
tenant id, which a GitHub Issue cannot give.

**Tension recorded, not resolved here**: 012 spec.md lists *ChatPost / ChatTask* under "deliberately
not persisted" ("a chat-task table would be a fourth copy of the task"). 014 spec Key Entities
introduces `WorkItem` and `ChatMessageRef`. The reading taken: `work_item` stores no task text of its
own beyond the post as data (FR-002) and the ledger reference, so it is not a copy of the task line
or the issue. 012's line should be amended by its owner to point here (see Unresolved U-07).

**Alternatives**: issue labels as the state (no transaction, no tenant scoping, editable by anyone
with triage rights); a 001 `Issue` as the work item now (FR-022 makes that the later mirror, 012
T101; 001's `IssueKind` has no member for a planned task).

## R-03 · A new domain package, `packages/domain/intake`

**Decision**: classification, the work-item state machine, the card rules, the report renderer, the
three ports (`ChatChannel`, `AgentExecutor`, `WorkLedger`) and the reason-code list live in a new
package `@healer/domain-intake` (`packages/domain/intake`). Adapters live in `packages/integrations`
(`telegram/`, `github/`, later `slack/`). HTTP routes live in `apps/api/src/intake`; queue processors
and the sweep body live in `apps/worker`. 012 FR-001 and 012 plan.md's package list are amended in
the same change (governance clause of the constitution).

**Rationale**: `packages/domain/*` maps one package to one numbered spec; 014 is a spec. None of the
existing packages owns this: `issues` is 001's incident aggregate, `workflow` is the generic machine
and callback mechanism, `policy` is 002. Putting the code in `apps/api` would leave the sweep body
(worker) and the routes (api) importing an app.

**Cross-package calls go through ports, wired in the apps.** The intake package declares a
`DispatchPolicy` port and a `SignalIntake` port; `apps/api` and `apps/worker` wire them to 002's
`evaluateAndBind` and 001's ingest command. No domain package imports another domain package — the
same convention `@healer/domain-policy`'s `record-audit-entry.ts` documents ("a cross-domain-package
dependency has no precedent in this repo and no ADR"). The intake writes `audit.audit_entry` through
its own infrastructure helper, as 004's `record-graph-audit-entry.ts` does.

**Alternatives**: `packages/domain/issues/intake` (001 does not own chat or executors); a
`packages/intake` shared package (it holds domain rules and a state machine, so it is a domain
package by the repository's own split).

## R-04 · The callback never waits inside a job, and its identity is the host's, not ours

**Decision**: dispatch is a short `execution`-queue job: evaluate policy, insert `work_job`, call
`workflow_dispatch`, move the work item to `running`, commit. Nothing waits for the run. The workflow
reports through `POST /api/v1/intake/jobs/{jobId}/events`, authenticated by a GitHub Actions OIDC
identity token requested inside the run with Healer's audience. The route verifies the token
(signature against GitHub's JWKS, `iss` a literal in the adapter, `aud`, `exp`), maps the verified
`repository_id` to the tenant through intake configuration, loads the job under that tenant, and
accepts the event only if the token is bound to that job:

| Claim | Must equal |
|-------|-----------|
| `repository_id` | the job's `host_repository_id` (an id, not the name — a rename keeps it) |
| `run_id`, `run_attempt` | the job's bound run; a re-run (`run_attempt` 2) is refused |
| `job_workflow_ref` | the workflow the job's grant names — an investigation run cannot report as a change run |
| `event_name` | `workflow_dispatch` |

**Binding the run.** If the dispatch response carries the run id (GitHub added run details to the
dispatch endpoint in 2026 — confirm against the live API when dispatch is built), it is bound at
dispatch. Otherwise the first `started` event binds it, under every other row of the table above
plus `actor` = the dispatching App; a second `started` naming a different run is refused and audited.
The callback is then applied once per `(job, seq)` along the closed graph (FR-018, data-model.md).

**Why not 012's callback registry token**: `packages/workflow` `callbacks.ts` issues a bearer token
per wait, stored hashed. Handing it to the run means passing it as a `workflow_dispatch` input, and
inputs are readable by anyone who can read the run. The OIDC token is minted by the host per run,
expires in minutes and names the run — a credential the run cannot forge and Healer never stores.
Verifying it needs a JWT library: [ADR 0019](../../docs/adr/0019-oidc-identity-token-verification.md)
(Proposed). Until it is accepted the route is built against the `CallbackVerifier` port and only a
fake verifier exists.

**Rationale**: ADR 0003 and constitution VI. A lost callback is not this route's problem; it is the
deadline sweep's (R-05).

**Alternatives**: polling the run's status from a job (a wait inside a job); a shared HMAC secret in
the repository (a long-lived credential every workflow can read, including the read-only one).

## R-05 · Stuck jobs and expired cards are swept by the C-90 schedule

**Decision**: one entry in `TENANT_SWEEPS` (`packages/workflow/src/schedule/tenant-sweep.ts`, the
only authority for which sweeps exist): `'intake-deadlines': { queue: 'scheduling', everyMs: 60_000 }`,
plus its body in `apps/worker`'s `sweepBodies` map (`Record<TenantSweepName, …>`, so a missing body
does not compile). Mechanics, exactly as ADR 0018 builds them: the BullMQ job scheduler fires
`tenant-sweep-fanout` every 60 s; the fan-out reads active tenant ids from `PrismaTenantEnumerator`
and enqueues one `intake-deadlines` job per tenant with `jobId`
`intake-deadlines__<tenantId>__<fan-out timestamp>`; the per-tenant job builds its context with
`TenantContext.forTrustedInternalUse` and runs the body. The body, each step a guarded update that is
a no-op on a row already moved on:

1. a card past `expires_at` on a work item still `awaiting_confirmation` → `expired`, card message
   re-rendered (US2 AS6);
2. a `work_job` with `ended_at IS NULL` and `deadline_at < now()` → work item `failed(timeout)`,
   `executor.cancel` enqueued (US4 AS2, FR-019);
3. a `confirmed` work item with no job and older than one sweep interval → its dispatch job
   re-enqueued (an enqueue lost after commit);
4. a `chat_message_ref` whose `rendered_version` is behind the work item's `version` → its render
   job re-enqueued (FR-029, US4 AS5).

`deadline_at = dispatched_at + wall-clock budget + grace` (R-12). The sweep never waits for a run
and never calls the host inline except through the enqueued cancel job.

**Consequences carried over from ADR 0018**: only `active` tenants are swept — a suspended tenant's
running jobs are not timed out until it is active again (acceptable: suspending a tenant should also
revoke its host token, FR-032). Delivery is at-least-once; the guarantee is the guarded update.

**Alternatives**: a delayed BullMQ job per work job (lost with Redis, and a second clock beside the
schedule); `setInterval` in the worker (ADR 0018 Rejected).

## R-06 · Read-only and change grants are separate workflows and separate tokens

**Decision**: FR-013's grant is what the host token allows, so the grant is chosen by **which
workflow is dispatched**, and each workflow can only obtain its own token:

| | Investigation | Fix / task |
|---|---|---|
| Workflow | `.github/workflows/agent-investigate.yml` (new) | `.github/workflows/agent-task.yml` (012 T089) |
| Repository token | `GITHUB_TOKEN` with `permissions: contents: read, issues: read, pull-requests: read, actions: read, id-token: write` | GitHub App installation token minted in the job, `contents: write, pull-requests: write, issues: write`; no administration; not a ruleset bypass actor (012 R-16) |
| App private key | not reachable — stored as an **environment** secret of environment `agent-change`, which this workflow does not name | available through environment `agent-change` only |
| Model key | its own spend-limited key (environment `agent-investigate`) | its own spend-limited key (012 R-16: one key per job class) |
| `timeout-minutes` | investigation wall-clock (R-12) | change wall-clock (R-12) |

The control plane holds a **dispatcher** credential — a GitHub App with `actions: write`,
`issues: write`, `metadata: read` and `contents: read` (to read `tasks.md`) — and never the change
App's key. Whether the dispatcher is a second App or the same App with a narrower installation token
is Unresolved U-03.

`.github/**` is a protected path (012 contracts/make-targets.md), so neither workflow can be widened
by an agent change set; the ruleset drift check (012 T092) is the reader for the host settings.

**Rationale**: a prompt that says "read only" is advice; a token without `contents: write` is a
refusal the host enforces. SC-006 is checkable from the workflow files and the environment settings.

**Alternatives**: one workflow with a `mode` input (the grant would be a string the dispatcher
chooses, inside a job that can read both keys).

## R-07 · Telegram: what the platform gives, and what it does not

**Decision and facts the design rests on** (Telegram Bot API):

- **Authenticity**: `setWebhook` takes a `secret_token` (1–256 characters of `A-Z a-z 0-9 _ -`);
  every delivery carries it in `X-Telegram-Bot-Api-Secret-Token`. The route compares it in constant
  time before reading the body, per channel key (FR-005). A mismatch is a 404 with no body, counted.
- **Dedupe**: each delivery is one `Update` with an `update_id` that increases per bot. The route
  inserts `(tenant_id, channel_key, update_id)` into `chat_update_seen` with `ON CONFLICT DO NOTHING`
  in the transaction that does the work; a repeat is answered 200 and changes nothing (FR-007).
  Telegram redelivers on a non-2xx, so a crash mid-transaction is safe.
- **Sender identity**: only a **group or supergroup** (or a private chat with the bot) carries
  `message.from.id`. A broadcast **channel** delivers `channel_post` with no sender id, so the
  allowlist cannot be applied there. The "channel" of C-48 is therefore a private supergroup per
  project; a `channel_post` update is ignored (U-05 asks Pavlo to confirm the wording).
- **Privacy mode**: by default a bot in a group receives only commands, replies to it and button
  presses. Commands and cards work with it on. Pasted findings (US5, stage 3) need privacy mode off
  or the bot as an administrator — a stage-3 setup step for the runbook (T104's successor).
- **Structure**: a command is a `bot_command` entity at offset 0 (`/fix@HealerBot` addressed to
  another bot is ignored); a forward carries `forward_origin`; a bot sender has `from.is_bot`; an
  edit arrives as `edited_message` and is ignored (spec edge case); a button press is a
  `callback_query` with up to 64 bytes of `callback_data` and must be answered with
  `answerCallbackQuery`.
- **Limits**: message text ≤ 4096 characters; roughly one message per second per chat and twenty
  per minute per group, `429` with `retry_after` beyond that; editing to identical content returns
  400 "message is not modified" (treated as success). The renderer caps text below 4096 and moves
  overflow to an issue comment (FR-024); edits are coalesced (R-10).

The adapter talks to the Bot API with `fetch` — no SDK, so no new dependency and nothing on
`gate-no-send`'s module list; see U-06 on what that gate can and cannot see.

## R-08 · Policy for a dispatch with no 001 issue

**Decision (proposed, needs 002's owner — U-01)**: two actions are registered in 002's
`SEED_POLICY_ACTIONS` (owning spec `014`): `intake.dispatch_investigation` (`read_only`,
`mutating: false`) and `intake.dispatch_change` (`code_change`, `mutating: true`). Every dispatch
calls `evaluateAndBind` through the `DispatchPolicy` port with `declaredMaxCost` = the job's spend
cap, so 002's budget charge holds the reservation (FR-012), and the decision id is stored on
`work_job`. Only `allow` dispatches; `deny` and `require_approval` end the work item
`failed(policy_denied)` carrying 002's own reason code.

**The gap**: 002's `DecisionInput` is issue-shaped — `target.issueKind`, `issue.state`,
`eligibility`, `reproduction` and `impact` are required. A work item has no 001 issue in the MVP.
002 has honest `absent` values for the verdict and the reproduction, but `impact.touches*` booleans
would have to be written `false` for a change nobody has analysed yet — a claim nothing checked. And
002 has no concurrency predicate. The intake therefore does **not** fill those groups; the plan
blocks stage 2's change dispatch on 002 answering one of: (a) a work-item subject variant of
`DecisionInput` with those groups absent by shape; (b) mirroring each work item into a 001 issue
first (pulls 012 T101 forward). Stage 1's read-only dispatch needs the same answer for
`target`/`issue`. The concurrency cap (FR-015 is per work item; the per-tenant cap of FR-012) is
enforced meanwhile by the partial unique index on `work_job` and a count under the dispatch
transaction, with reason `concurrency_cap` — a deterministic intake check, not a 002 decision, and
labelled so.

## R-09 · A job's cost lands in `agent_run`, not in `work_job`

**Decision (proposed — U-02)**: the `ended` event's reported cost is written as an `agent_run` row
(`agent_kind` `investigator` or `change`, `cost_provenance = reported`, `policy_decision_id` = the
dispatch decision, `correlation_id` = the work item's), and `work_job.agent_run_id` points at it.
This keeps 012's rule that `agent_run` is the single store of agent-run facts (C-13), lands 002's
budget charge through the path T094 already built, and satisfies FR-030 with C-95's label.

**What it needs**: `agent_run.executed_in` has `control_plane | runner`; a GitHub Actions job is
neither, so the enum gains `external_host` (a migration of 012's table, with the
`agent_run_runner_iff_runner_instance` CHECK unchanged), and `prompt_version_id` is required — the
fixed directive prompt of FR-002 is registered in the prompt registry (FR-041) and its id travels in
the directive, which also makes "the prompt is byte-identical" (SC-002) a comparison of ids. Without
it, a consumed charge is never replaced by an actual cost (`abandoned-charges-release` frees only
never-consumed decisions) and holds the budget — so stage 1 does not ship before U-02 is answered.

**Alternatives**: a `reported_cost` column on `work_job` (a second store of agent spend that 002's
budget never reads — the failure C-13 exists to prevent).

## R-10 · Reports: structured in, digests out, one message edited in place

**Decision**: the run never sends text to the channel. Its last workflow step validates the agent's
report file against the `ended` schema of
[contracts/executor-port.md](contracts/executor-port.md) and posts it; the control plane renders the
message. Rules:

- **Findings must cite.** Each finding carries one or more references of a closed kind (`file_line`
  with path, line and commit, `ci_run`, `issue`, `pull_request`). A finding with none is dropped
  before rendering and counted as `findings_withheld` on the report (FR-026, SC-008). Each reference
  is resolved through the ledger port (the file exists at that commit, the run, issue or pull request
  exists in the bound repository); an unresolvable one counts as no reference. Existence is checked;
  support is not — see the constitution check in plan.md.
- **Outgoing text is scanned.** Model-written strings (finding claims, the `needs-decision` question)
  pass a secret scan reusing the runner's detector implementations for `private_key_block`,
  `connection_string` and `bearer_token` (`apps/runner/src/collection/redaction/detectors.ts`, lifted
  into a package both can import — a task, not a copy) and a per-field length cap. A failure withholds
  the whole message body with `report_withheld_secret`; the work item's state is unaffected (FR-025).
- **One message per job, edited.** `chat_message_ref.rendered_version` trails `work_item.version`.
  Every state change increments `version` in its own transaction and enqueues a render job with
  `jobId` `intake-render__<workItemId>__<version>` and a 1.5 s delay; the processor renders the
  current state and is a no-op if `rendered_version` is already current — so bursts coalesce into the
  latest render and BullMQ's retained completed ids cannot swallow a later version. A `429` re-queues
  after `retry_after`; any failure leaves the state alone and the sweep repairs it (R-05 step 4).
- **Overflow** beyond the channel's limit goes to the ledger issue as a comment, and the message
  keeps the verdict, the head of the evidence list and the link (spec edge case). An investigation
  with no issue gets one created for the overflow only when the owner presses "open issue".

## R-11 · Secrets until the secret manager exists (debt, 012 T066)

**Decision**: the bot token, each channel's webhook secret and the dispatcher App's private key are
read only through `packages/shared/src/config` (the one place `process.env` is allowed), validated at
start and reported by presence only, never logged, never placed in a directive, a report or an
evidence record (FR-031). The change App's key and the model keys never reach the control plane
(R-06). **Debt**: 012 T066 (secret manager) is deferred with no ADR (QUESTIONS.md "012 phase 8–10");
until it exists these are environment variables on the control-plane host, rotated by hand per the
runbook (FR-032). The debt is recorded in QUESTIONS.md and in the runbook task, and the config module
names the debt in the variable's description.

## R-12 · Starting values, chosen to fail closed

Policy data (002 budgets) unless marked; they are starting values, not derived (constitution
Governance), tuned against the first month of `agent_run` cost per job class.

| Value | Start | Where it lives | Clamp |
|-------|-------|----------------|-------|
| Investigation wall-clock | 20 min | `agent-investigate.yml` `timeout-minutes` (authority); the control plane's deadline constant is pinned to it by a test that reads the workflow file | ≤ 60 min |
| Change wall-clock | 60 min | `agent-task.yml` `timeout-minutes`, pinned the same way | ≤ 180 min |
| Grace before `failed(timeout)` | 10 min | intake constant (host queueing delay) | — |
| Per-investigation spend cap | USD 3 | 002 budget, `declaredMaxCost` | model key limit is the hard stop |
| Per-change spend cap | USD 15 | 002 budget | model key limit is the hard stop |
| Per-tenant daily intake spend | USD 30 | 002 budget, tenant/day | — |
| Running jobs per tenant | 2 | intake check (R-08) | — |
| Card time to live | 15 min (spec default) | intake configuration | ≤ 60 min |
| Smoke time budget (SC-007) | 60 s | `make intake-smoke` | — |

## R-13 · Tenant on the two routes, and the isolation tests

**Decision**: neither route reads a tenant header (the existing controllers' `X-Tenant-Id` stub is
not used — FR-008). The webhook resolves the tenant from the channel configuration named by the path
key, and only after the secret matches; the callback resolves it from the verified token's
`repository_id` through intake configuration. Every query then carries that tenant.

**Isolation test**: `gate-isolation` recognises calls to the helpers in `test/tenant-isolation.ts`,
which take a `tenantHeader` and send the tenant id as its value. These routes take a credential, not
a tenant id, so the helper needs one optional field — a function from tenant to request headers.
`test/*.ts` is a protected path: that change is human-authored (U-04). The property asserted is the
usual one: tenant B's credential against tenant A's job or channel returns 404 and writes nothing.

## R-14 · `make intake-smoke` runs the real path in-process

**Decision**: the target starts Postgres and Redis (Testcontainers, 012 R-12), builds the API and
worker modules in one process the way the e2e suites do, and points the Telegram and GitHub adapters
at two local fake servers through **constructor arguments, not configuration** — the Bot API base
URL and the OIDC issuer are literals in the adapters, so production cannot be pointed elsewhere by a
setting. The fake host signs OIDC tokens with a local key whose JWKS is handed to the verifier the
same way. It posts `/investigate`, lets the fake host call back `started`, two `step`s and `ended`
with a cited `found` report, and passes only when the fake chat server holds one message whose last
edit is the terminal report — within 60 s. Contract in 012
[contracts/make-targets.md](../012-engineering-foundation/contracts/make-targets.md); scenarios in
[quickstart.md](quickstart.md).

## R-15 · Classification reads structure only

**Decision**: the classifier is a pure function of the parsed `ChannelEvent`
([contracts/channel-port.md](contracts/channel-port.md)) — never of the text's wording. Order:
button press → reply to a card or report → command entity at offset 0 → forwarded / bot sender /
attachment-or-multi-line paste → unclassified. The text after a command is the argument as data
(FR-002); the argument grammar is closed ([contracts/command-grammar.md](contracts/command-grammar.md)).
The directive is assembled from the work item's typed fields and a fixed, registered prompt; the
description is placed in one delimited data block, so a post saying "ignore previous instructions"
changes the block's bytes and nothing else (SC-002 compares every other directive field).

## Out of scope

- The open item in QUESTIONS.md "012 T094 — post-push security review" (a report can release a
  same-issue, same-run AI step's charge because `action_key` is not checked). It touches the same
  `recordAgentRunReport` path R-09 proposes to use, and needs 002's closed list of agent-step action
  keys first; it is not taken up here.
- 012 T099 (ready-task selection) and T100 (follow-up loop): cross-referenced, not duplicated. 014
  stage 3 consumes T100's answer for `needs-decision` replies.

## Unresolved

Needs Pavlo or another spec's owner. Each blocks the stage named.

| # | Question | Blocks |
|---|----------|--------|
| U-01 | 002's `DecisionInput` for a dispatch with no 001 issue, and where the per-tenant concurrency cap lives (R-08) | stage 1 dispatch |
| U-02 | `agent_run.executed_in` gains `external_host`, and the directive prompt is registered, so the job's cost lands in `agent_run` (R-09) | stage 1 ship |
| U-03 | Dispatcher credential: a second GitHub App, or the agent App with a narrower installation token (R-06) | stage 0 |
| U-04 | Human-authored change to `test/tenant-isolation.ts` for credential-based routes (R-13) | stage 1 isolation tests |
| U-05 | "Telegram channel" means a private supergroup — a broadcast channel carries no sender id (R-07) | stage 0 setup |
| U-06 | `gate-no-send` sees module imports only; a `fetch` to the Bot API is invisible to it. Accept, or add a structural check that only `packages/integrations/src/{telegram,slack}` names the platform hosts | stage 1 |
| U-07 | 012 spec.md's "ChatPost / ChatTask — deliberately not persisted" and FR-053 / T088's "names a `tasks.md` identifier" both conflict with 014 (R-02; plan.md "Spec inconsistencies") | stage 2 |
| U-08 | ADR 0019's library choice (Proposed) | stage 1 callback route |
