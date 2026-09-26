# ADR 0011: Agent-driven development under the same gates

## Status

Accepted — 2026-09-26. Specified in 012 US10 (FR-053..FR-059), research R-13..R-16, C-37, C-40.

## Context

The specifications hold over a thousand tasks, and coding agents can implement a well-bounded one. An
agent follows instructions literally: it will not route around a gate it cannot see, and it will
route around one it can edit. The controls that make its work safe therefore have to sit where its
prompt cannot reach — in the build, in the repository host and in the model provider.

## Decision

A coding agent implements **one task per pull request** as a GitHub Actions job, with a GitHub App
identity. The build decides whether its change is admissible; a human decides whether it merges.

- **Identity** is the host's bot flag, never commit or pull-request text; unresolvable counts as an
  agent (R-13).
- **Scope**: an agent change set cannot touch a protected path — gates, lint and boundary
  configuration, specifications, ADRs, the constitution, shared test helpers, CI — and cannot weaken
  an assertion in a pre-existing test (`gate-agent-scope`, R-15). The list has one authority, the
  make-targets contract, and protects itself.
- **Red first**: its behavioural change must carry a test that fails on the base revision
  (`gate-red-first`, R-14).
- **Merge** is a repository ruleset the App cannot bypass, read on a schedule for drift (R-16, C-40).
- **Budgets** are the job timeout and the model key's own spend limit.
- **Seams stay human**: specify, clarify and analyze are not delegated. An agent that needs a decision
  opens a draft pull request labelled `needs-decision` and stops.

## Rejected

- **Rules in the agent's prompt or `AGENTS.md` alone** — a prompt is advice; the constitution already
  says permissions are what tools grant.
- **Agents on developer machines** — the token, the budget and the working tree become whatever that
  machine has.
- **An in-house agent orchestrator** — a CI job with a concurrency group already is one.

## Consequences

- \+ The gates written for people now also bound agents, with two additions rather than a second system.
- \+ Healer's own development runs at L2, the ceiling it imposes on customers.
- − Protected-path edits need a human author, so a task that requires one stops half-done by design.
- \+ With the GitHub adapter in v1 (C-42), Healer runs its own pipeline on this repository: its
  agents, its regression suite (013) and its incidents are the product's first real tenant.
