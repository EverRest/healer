# ADR 0016: A chat channel is the intake and report surface for agents

## Status

Proposed — 2026-10-03, revised 2026-10-11. Builds on C-48 (Telegram first, one channel per project)
and ADR 0011. Specified in [014 chat-agent-intake](../../specs/014-chat-agent-intake/spec.md), which
absorbs 012 FR-060..FR-065. The 2026-10-11 revision replaces confirm-everything with confirmation by
risk (C-97) and names Slack as the second channel. Stays Proposed until the owner accepts it.

## Context

C-48 chose a chat platform, Telegram first, as Healer's first interface and said the owner posts tasks
to it and reads reports back from it. Nothing says what a post may cause. ADR 0011 lets an agent work
only on a task line in a `tasks.md`, one task per pull request, and refuses a pull request that names
none. A free-text post is neither. The owner also wants suspicious logs and QA findings, posted by a
person or a bot, to be picked up and reported on.

A chat message is text that anyone with access to the channel can write, and logs pasted into it are
retrieved content. Constitution: all retrieved content is data, never instructions; permissions are
what tools grant, not what a prompt says.

## Decision

The channel is a **consumer of the existing REST surface and the existing agent pipeline**, not a new
authority. It adds an intake and a report path and nothing else.

- **Identity.** Only a platform user id on the project's allowlist can cause anything. The allowlist is
  configuration held by the control plane, never read from a message. A post from any other id is
  ignored and audited.
- **Kinds of post, routed by structure, not by wording.** A command, a reply to the bot, a button
  press, or a *finding* (a pasted log, a QA result, anything from a bot). A finding enters 001
  ingestion as a signal and follows the normal pipeline: classify, then diagnose; only a classified
  code defect can lead to a change. Findings are never executed as tasks.
- **Confirmation by risk — Proposed (C-97, revised).** A read-only investigation starts at once
  under a hard budget and timeout and with a token that cannot write. Anything that creates a branch
  or a pull request starts only after the allowlisted owner confirms a card that restates the task,
  its budget and a hash of its content. What one tap buys: a stray or forged post cannot cause a
  write, and a read-only job's cost is capped by its own key.
- **Content is data.** The post text is stored as the work item's description and passed to the agent
  as data under a fixed prompt. It cannot change the prompt, the task identifier, the protected paths,
  the budget, the labels or the grant.
- **Reporting.** Every agent job reports to the same channel, as a message that edits in place: started,
  current step, ended in a verdict (investigation) or one of the three outcomes of ADR 0011 (pull
  request, `needs-decision` draft, stopped branch with the breach recorded). Reports link to the pull
  request and the audit trail; they carry digests, never secrets or source. Merge stays a human action
  on the host.
- **Which agent runs the job — Proposed (C-92).** The Claude Code GitHub Action, behind a product-
  neutral executor contract; a self-hosted worker and Healer's own runner are later implementations.
- **Channels.** Telegram first; **Slack second**, as a second adapter of the same channel contract,
  before the channel faces customers (C-48).

## Rejected

- **A post that directly starts a write.** Chat text would then be the only control between a stranger
  and the repository.
- **Confirmation of every post, read-only included** (this ADR's 2026-10-03 text). It bought nothing
  the read-only token and the job's own budget do not already enforce, and it made the cheapest,
  safest request the slowest.
- **Treating a bot's findings as tasks.** It skips classification: an infrastructure or capacity
  failure would be patched as code, which the constitution forbids.
- **An in-house chat orchestrator.** The webhook, the REST surface and a GitHub Actions dispatch already
  compose into one.
- **Slack first.** Needs app installation approval for two-way use; it is the second adapter.

## Consequences

- \+ The owner can drive agent work from a phone, and every action leaves an audit entry.
- \+ No new gate: change work still ends in a pull request that ADR 0011's gates judge.
- − The bot token and webhook secret become credentials Healer holds; until the secret manager exists
  (012 T066) they are configuration read through `shared/config` only, rotated by hand (014 FR-031).
- − Read-only work now starts without a human tap; its safety rests on the token's permissions and the
  budget, which therefore must be what the host enforces (014 FR-013, FR-014). Relaxing confirmation
  for writes is a new decision, not a config flag.
