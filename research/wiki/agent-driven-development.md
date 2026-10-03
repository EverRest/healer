# Agent-driven development

How Healer itself is built with coding agents, and why the controls look the way they do. Specified in
012 US10 and [ADR 0011](../../docs/adr/0011-agent-driven-development.md); this page is the reasoning.

## The premise

The specifications hold over twelve hundred tasks, each with requirement references, a file path and,
usually, a quickstart scenario that fails first. That is close to the ideal input for a coding agent.
The question is not whether agents can implement tasks; it is what stops an agent from landing something
the specification does not allow.

## A literal implementer

An agent follows the gradient it is given. Under a failing gate it will fix the code, weaken the test or
edit the gate, and the last two are usually shorter. This is not a defect of any particular agent; it is
what optimising for "make the check pass" means. Rules in a prompt or in `AGENTS.md` are advice. The
constitution already says it about Healer's product agents — permissions are what tools grant, not what
prompts say — and it applies unchanged to the agents building Healer. See
[failure-modes](failure-modes.md) §14.

## What holds, and where

| Control | Where it lives | Why there |
|---|---|---|
| Who is an agent | the repository host's bot flag (GitHub App, `type: Bot`) | commit text and trailers are written by the author they would constrain |
| What an agent may touch | `gate-agent-scope`, protected paths in one contract | gates, lint, specs, ADRs and the constitution are the judge |
| Weakened tests | the same gate, on removed assertion lines in pre-existing tests | an implementer editing its own anchor is circular verification |
| New behaviour has a real test | `gate-red-first`, run against the base revision | "I saw it fail" is a claim; a rerun is a fact |
| Merge | a repository ruleset the App cannot bypass, read weekly for drift | a setting checked once has no reader afterwards |
| Budget | CI job timeout and the model key's own spend limit | the agent's prompt cannot reach either |

## The seams stay human

`/speckit-analyze` found roughly a hundred and ten problems in the specifications, and every one of them
sat between two specifications, not inside one. The same pattern repeated in this project's later work:
the unshaped source crossing (ADR 0010) and 013's first draft contradicting 005's adoption rule were both
seam defects. A literal implementer is at its worst exactly there, because each side of the seam is
internally consistent.

So specify, clarify and analyze are not delegated. An agent that needs a decision the documents do not
contain opens a draft pull request labelled `needs-decision` and stops.

## Dogfooding

Healer's repository is on GitHub and v1 includes a GitHub adapter (C-42), so Healer's own incidents,
regression suite and agent-authored pull requests run through the same pipeline customers get. That
makes Healer its own first tenant and its own first source of real incidents for the benchmark — with the
usual caveat that incidents from one team's product are not a sealed measurement set for anyone else's
(011, [failure-modes](failure-modes.md) §10).

## Task intake and reports through a chat channel

The owner wants one chat channel per project (C-48, Telegram first) where tasks, bugs and suspicious
logs or QA findings are posted by a person or by a bot, and where agents report what they picked up and
how it is going. Specified in 012 FR-060..FR-065 and [ADR 0016](../../docs/adr/0016-chat-channel-agent-intake.md);
this is the reasoning.

**A chat message is a wider door than a task line.** ADR 0011 admits only a task line from `tasks.md`.
A channel admits text from anyone who can write to it, and from bots whose output is somebody else's
log. If the post itself started an agent, the channel would be the only control between a stranger and a
model budget, and a prompt-injection line in a pasted log would be an instruction. So the channel adds
no authority: it is a consumer of the REST surface, and everything it triggers still ends at ADR 0011's
gates and a human merge.

| Question | Answer | Why |
|---|---|---|
| Who may cause anything | an allowlist of Telegram ids in control-plane configuration | an id inside message text is written by the author it would authorise |
| What a task post does | becomes a task line or issue, then waits for the owner's confirmation | keeps "one task per pull request" true; one tap prevents a forged post spending a budget (proposed) |
| What a finding post does | enters ingestion as a signal and is classified before anything is patched | infrastructure, capacity and config failures are not code bugs; patching them is the failure the taxonomy exists to prevent ([incident-taxonomy](incident-taxonomy.md)) |
| What the post text is | data in the task description, never prompt | retrieved content is data, never instructions ([security-posture](security-posture.md)) |
| What reports contain | identifiers, digests, a link to the pull request | the pull request and audit trail are the record; a chat is a notification, not evidence |
| What the channel can do on the host | nothing beyond asking, confirming and reading | merge and approval are human actions on the host (FR-057, FR-065) |

**Why not skip confirmation.** The cost is one tap per task; the failure it prevents is silent and
expensive. Relaxing it should be a measured, recorded decision, for example after a period with no
unwanted job — not a flag.

**Why findings are not tasks.** A log pasted as "this is broken" is a symptom. Turning it directly into
an agent task skips reproduction and classification, the two steps that separate Healer from a tool that
patches whatever it is shown (`AGENTS.md`: reproduce before modifying, classify before patching). The channel is the same front door
as any other signal source.

**Open.**
- Which coding agent runs in the job (proposed: the Claude Code GitHub Action).
- How a bot such as a QA runner identifies itself in the channel; Telegram bots can read only what is
  addressed to them, so the allowlist must name the bot's own id and the finding format must be fixed.
- Whether the same intake becomes a per-tenant feature for customers; that is the Slack question in C-48
  and a separate decision.

## Open

- Whether agents should draft `plan.md` and `tasks.md` from an approved `spec.md`. Today they do not; the
  argument for it is speed, the argument against is that tasks are where seams become visible.
- How to measure agent output quality beyond "the gates passed and a human merged". Revert rate within
  thirty days, as for product fixes, is the obvious candidate (unverified as a useful signal at this scale).
