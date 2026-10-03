# ADR 0016: A chat channel is the intake and report surface for agents

## Status

Proposed — 2026-10-03. Builds on C-48 (Telegram first, one channel per project) and ADR 0011.
Open until the owner confirms the two choices marked **Proposed** below.

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

- **Identity.** Only a Telegram user id on the project's allowlist can cause anything. The allowlist is
  configuration held by the control plane, never read from a message. A post from any other id is
  ignored and audited.
- **Two kinds of post, routed by structure, not by wording.** A *task* post (a command, or a reply to
  the bot's task prompt) becomes a task line or tracked issue. A *finding* post (a pasted log, a QA
  result, anything from a bot) enters 001 ingestion as a signal and follows the normal pipeline:
  classify, then diagnose; only a classified code defect can lead to a change. Findings are never
  executed as tasks.
- **Confirmation before work — Proposed.** A task post produces a card with the task as it was
  understood; an agent job starts only after the allowlisted owner confirms it. One tap buys: a stray or
  forged post cannot spend a model budget.
- **Content is data.** The post text is stored as the task's description and passed to the agent as data
  under its prompt. It cannot change the prompt, the task identifier, the protected paths or a budget.
- **Reporting.** Every agent job reports to the same channel, as a message that edits in place: started,
  current step, ended in one of the three outcomes of ADR 0011 (pull request, `needs-decision` draft,
  stopped branch with the breach recorded). Reports link to the pull request and the audit trail; they
  carry digests, never secrets or customer source. Merge stays a human action on the host.
- **Which agent runs the job — Proposed.** The Claude Code GitHub Action, authenticated with the App
  token of 012 R-16. The controls (012 FR-053..FR-059) name no product; only the workflow step does.

## Rejected

- **A post that directly starts an agent.** Chat text would then be the only control between a stranger
  and a model budget.
- **Treating a bot's findings as tasks.** It skips classification: an infrastructure or capacity
  failure would be patched as code, which the constitution forbids.
- **An in-house chat orchestrator.** The webhook, the REST surface and a GitHub Actions dispatch already
  compose into one.
- **Slack first.** Needs app installation approval for two-way use; revisit before the channel becomes
  customer-facing (C-48).

## Consequences

- \+ The owner can drive agent work from a phone, and every action leaves an audit entry.
- \+ No new gate: the work still ends in a pull request that ADR 0011's gates judge.
- − The Telegram bot token and webhook secret become credentials Healer holds; they are held like any
  other secret (secret manager, rotated by hand, never in a directive).
- − Confirmation adds a step to every task; if it proves too slow, relaxing it is a new decision, not a
  config flag.
