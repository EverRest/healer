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

## Open

- Whether agents should draft `plan.md` and `tasks.md` from an approved `spec.md`. Today they do not; the
  argument for it is speed, the argument against is that tasks are where seams become visible.
- How to measure agent output quality beyond "the gates passed and a human merged". Revert rate within
  thirty days, as for product fixes, is the obvious candidate (unverified as a useful signal at this scale).
