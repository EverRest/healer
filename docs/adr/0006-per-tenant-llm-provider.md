# ADR 0006: Per-tenant LLM provider configuration

## Status

Accepted — 2026-09-23

## Context

Hybrid deployment (ADR 0001) keeps the repository in the customer's network, but when the change
agent runs, **the customer's source code is in the prompt**. It reaches a model provider regardless
of where the repository lives. Enterprise security review will ask about this specifically, and
"the code never leaves" would be false.

## Decision

Provider configuration is **per tenant**, from day one.

- Default: Healer's own provider access. Fast to onboard, one contract, predictable billing. For calls
  that run in the runner (ADR 0010) this is a per-tenant, spend-limited, revocable key held in the
  customer's secret manager — never a shared key, never a Healer proxy (C-34).
- Enterprise option: customer brings their own model access — their Bedrock or Vertex account,
  their key, their DPA with the provider. Inference then happens under contracts they already
  signed.
- Direct provider SDKs on the production path; OpenRouter in the evaluation harness only, where
  breadth is the point and routing variance does not contaminate customer work.

## Consequences

- \+ The strongest available answer to "who sees our source code" without lying about it.
- \+ Cheap now; retrofitting per-tenant provider configuration later is painful and touches every
  agent call site.
- − Benchmark results are per provider and per model version; a BYO tenant may run a different
  version than the one measured, so the benchmark's applicability must be stated rather than assumed.
- − Billing, rate limits and failure handling differ per tenant and must be modelled, not averaged.
