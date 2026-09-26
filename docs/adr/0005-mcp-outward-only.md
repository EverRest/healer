# ADR 0005: MCP is an outward-facing surface, not internal plumbing

## Status

Accepted — 2026-09-23

## Context

The original design had Healer's own agents calling tools through MCP. It also described MCP as an
adapter over domain services for external agents. These are different systems, and the difference
matters for permissions.

## Decision

Healer's own agents call domain services through typed in-process interfaces. MCP exposes the same
capabilities **outward**, so a customer can point their own agent tooling at Healer's investigation
surface.

## Consequences

- \+ Internal calls keep types, stack traces and transactions; MCP flattens all three.
- \+ **Capability scoping lives in one place.** If internal agents went through MCP, "the diagnosis
  agent cannot write to a repository" would be enforced in both the domain layer and the MCP layer,
  and the two would drift.
- \+ The outward surface is a genuine distribution channel rather than overhead.
- − Two call paths to the same capabilities, so the MCP layer needs contract tests proving it does
  not diverge from the domain services it wraps.
