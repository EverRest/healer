# ADR 0010: Inference follows the source

## Status

Accepted — 2026-09-26. Amends ADR 0001 (what the control plane hosts) and ADR 0006 (where the
Healer-managed credential lives). Constitution 1.2.0.

## Context

The runner contract says file contents never cross the boundary. ADR 0006 and the security posture
say the customer's source code is in the change agent's prompt. The change agent lived in the control
plane, so the only way both could be true was a path that no specification described: source text
travelling from the runner to the control plane to reach a prompt. That path would have been the
single largest crossing in the product, and it had no shape, no bound and no reader.

## Decision

**A model call runs where its inputs live.** A call whose input includes content that may not cross
the boundary — source text, patch content, anything the runner contract lists under "never crosses" —
executes **in the runner**, against the tenant's configured provider, and its results return only as
closed contract shapes. A call whose inputs are all shapes that already crossed stays in the control
plane.

In v1 that places in the runner: the **change agent** (reads and writes source), the **masking
inspection** of the diff (008 FR-014) and the **verifier** (reads the patch; 008 FR-016). Diagnosis
(006) and AutoSupport (009) work on crossed evidence and stay in the control plane; if either later
needs source, the call moves, the shape does not widen.

- **The control plane still orchestrates.** Policy, workflow state, budgets and audit stay where they
  are. The runner receives an `agent_directive` naming the agent, a pinned prompt version and its
  digest, input references and a budget, and it returns an `agent_run_report` — model, prompt version,
  tokens, cost, tool names, outcome, duration, no content — from which the control plane writes
  `agent_run` (012 FR-033 stays the single store).
- **The patch never leaves the customer's network.** The change agent returns a `ChangePlan` proposal
  as paths and enumerations for policy (008 FR-004); the approved plan returns to the runner; the patch
  is applied there and reaches humans only as a pull request in the customer's own VCS.
- **Credentials.** A customer-supplied tenant's runner uses the customer's own provider account.
  A Healer-managed tenant's runner holds a **per-tenant** provider key issued by Healer: spend-limited,
  revocable, provisioned into the customer's secret manager at onboarding and never sent over the
  runner protocol. There is no shared key and no Healer inference proxy.
- **Prompts.** Prompt text is Healer's, not the customer's, so it may cross towards the runner. The
  runner fetches a prompt version by identifier and refuses it unless its digest matches the one in
  the directive (012 FR-038, FR-039).
- **Capability.** Runner-side inference is a declared capability. Its absence refuses every agent
  directive, because the change agent's path changes state (C-02).

## Rejected

- **Inference in the control plane with a bounded `code_excerpt` shape.** Honest and simpler to
  build, but it makes Healer a processor of customer source in transit, which is the question an
  enterprise review asks first, and a bound on excerpts is a bound an agent's appetite for context
  will push against every release.
- **A Healer inference gateway the runner calls.** Keeps our billing simple and brings the source back
  through our infrastructure — the problem this decision exists to remove.
- **The whole agent loop and its orchestration in the runner.** Moves policy, budgets and audit into
  infrastructure we do not operate and cannot observe, and makes every policy change a runner upgrade.

## Consequences

- \+ "Healer never processes your source code" becomes true. Source still reaches a model provider —
  from the customer's network, under the tenant's provider configuration — and the security posture
  says so.
- \+ A customer-supplied tenant's code reaches only the provider they contracted with, with no Healer
  hop, which makes ADR 0006's enterprise option materially stronger.
- − The runner needs outbound access to the tenant's provider endpoint, in addition to the control
  plane. The sandbox is unaffected and keeps default-deny egress.
- − `packages/agents`, `packages/llm` and the prompt client ship inside the runner image. Agent
  behaviour is now versioned with the runner, so benchmark results (011) pin the runner image
  version as well as model and prompt version.
- − A Healer-managed key sits in customer infrastructure. Its spend limit is the hard budget stop;
  the control plane's budgets (002 FR-011) remain the policy stop and read the reported cost, which
  is reconciled against provider usage per key.
- − Model output is a leak channel. Everything a runner-side agent returns maps onto closed shapes
  with no free-form strings (R-04); explanatory prose generated from source stays in the customer's
  pull request.

## Open — resolved

005 builds the knowledge index in the control plane from customer documents. Embedding a document is a
model call over content that `knowledge_ref` says does not cross. Whether embeddings move to the
runner, or document text is admitted as its own shape, was tracked as [stage-0 S0-8](../stage-0.md) and is resolved by C-36: no vector index over customer
documents in v1.
