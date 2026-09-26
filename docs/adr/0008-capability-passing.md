# ADR 0008: Capability passing for irreversible operations

## Status

Accepted — 2026-09-24

## Context

Simulation must not be able to mutate anything (011 FR-004). The obvious implementation is a
`dryRun` flag threaded through the call stack, checked before each mutating operation.

That is not a guarantee, it is a convention. It fails the moment someone adds a code path that
forgets the check, and the failure is silent until a simulation writes to a customer's repository.
The same weakness applies elsewhere: an agent's permissions being "what its prompt says" rather
than what its tools grant (constitution, Security Model).

Constitution VIII requires an ADR for a new cross-cutting pattern. This is one.

## Decision

**Every irreversible operation takes a capability object as an argument and cannot obtain one any
other way.** It may not resolve a capability from the dependency-injection container, a module
import, ambient configuration or a global.

The operations in scope:

| Operation | Capability required |
|-----------|--------------------|
| Repository write and pull-request creation (008) | `RepositoryWriteCapability` |
| Remediation dispatch to the runner (010) | `RemediationDispatchCapability` |
| Support answer publication (009) | `AnswerPublishCapability` |
| Knowledge draft publication (005) | `DraftPublishCapability` |

A run is constructed with a capability bundle. A simulation run is constructed with a bundle
containing none of them, so a mutating function **cannot be reached** — not "is not called".

Two supporting mechanisms:

- **Lint patterns** (012 FR-002, FR-003) forbid importing the mutating infrastructure modules
  outside the privileged execution packages, so a capability cannot be reconstructed locally.
- **Credential minting** uses a closed enum of principal kinds; a simulation principal has no
  mintable credential for a mutating operation, so even a smuggled capability resolves to nothing.

## Consequences

- \+ The no-mutation guarantee is structural and checkable, rather than a flag whose correctness
  depends on every future author remembering it.
- \+ The same mechanism enforces per-agent permissions: the diagnosis agent's bundle simply has no
  repository-write capability, which is what "permissions are what tools grant" means concretely.
- \+ A reviewer can answer "can this path mutate?" by reading the signature, not the body.
- − Call signatures get wider, and capabilities must be threaded through orchestration code.
  Accepted: the widened signature is the documentation.
- − Retrofitting an operation missed at the start is invasive, so the list above is reviewed
  whenever a new irreversible operation is specified.
- The pattern does not apply to reversible or read-only operations; applying it everywhere would
  make it noise and the noise would hide the cases that matter.
