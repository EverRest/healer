# LLM stack choices

What Healer builds itself and what it uses off the shelf for model access, agent loops and workflow
orchestration — and when each answer would change. Binding decisions are ADR 0003, ADR 0006, ADR 0010
and the constitution's technology table; this page is the reasoning, including options evaluated and
not taken.

## Three layers, three answers

| Layer | Healer's choice | Reverse it when |
|---|---|---|
| Model access | direct provider SDKs behind one `LLM` interface; OpenRouter only in the eval harness | never on the production path while customer source is in prompts |
| Agent loop | in-house tool-use loop, roughly a hundred lines | agents become short-lived, stateless and permission-free — not this product |
| Workflow orchestration | BullMQ plus a persisted state machine in Postgres | dozens of heterogeneous long-running workflows with sagas (ADR 0003) |

## Model access: why not a router in production

A router such as OpenRouter is the right tool when breadth matters — comparing models, prototyping, the
eval harness. In production it costs three things Healer cannot pay:

- **Another processor of customer source.** Every prompt with source in it passes through one more
  company.
- **Routing variance.** The same model identifier can be served by different providers or
  quantisations. The audit trail must name the exact model that produced a patch, and a benchmark must
  measure what production runs.
- **Bring-your-own access.** A customer's Bedrock or Vertex account is the strongest security answer
  Healer has (ADR 0006); a router in the middle undoes it.

ADR 0010 raised the stakes further: model calls over source now run in the runner, from the customer's
network, and only the tenant's own provider configuration applies there.

## Agent loop: why not a framework

Agent frameworks (LangGraph, Mastra, LangChain and similar) earn their keep when an agent lives for one
request, keeps its state in memory and calls tools without a permission model. Healer's agents are the
opposite on every axis: each tool call passes policy and writes an audit record, credentials are scoped
per agent, state lives in Postgres because no job may wait, and `agent_run` must be the single store of
agent-run facts — a framework's tracing store would be a second one (012 FR-033). The framework would save
the hundred lines of the loop and cost the constant work of routing around its abstractions.

A thin provider abstraction (for example the Vercel AI SDK) is a different question: it unifies calls,
not orchestration. It becomes worth an ADR if the number of supported providers grows past three.

## Orchestration: why not Temporal

See ADR 0003. The workflow machine's state has to be in Postgres anyway, for audit and the dashboard. The
rule that no job waits keeps BullMQ sufficient and keeps a later move to Temporal mechanical.

## Evaluated: System One models (TypeSafe Jev), 2026-09-26

Source: [typesafe.ai — Introducing System One models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
Vendor-reported claims, all **(unverified)**: typed outputs from a predeclared schema of up to 255
choices with calibrated probabilities, 70–500 ms latency, input at $0.042 per million tokens, early
access, hosted in the US only, no self-hosting mentioned. The vendor itself notes its benchmarks were
built by its own team and that its pricing may be subsidised.

Where it would fit technically: issue classification (006 FR-001), AutoSupport category checks (009),
alert deduplication at ingestion, retrieval re-ranking, injection screening of retrieved content.

Why not now:

1. **Per-tenant provider configuration** (ADR 0006) and runner-side inference (ADR 0010) require models a
   tenant can bring or that run under the tenant's configuration; a US-only hosted early-access service
   is one more sub-processor for every customer.
2. **Model confidence is never a gate.** The product's selling point — calibrated probabilities — cannot
   be used as a gate in Healer by constitution; without that, it is one more proposer.
3. **It does not touch the expensive part.** Time goes to sandboxes, CI and reproduction; money goes to
   diagnosis and code generation, which a model without string output cannot do.

How to revisit: add it as a provider in the eval harness (011) only, and measure it on the sealed
benchmark for classification, where the gate-miss rate is already a release gate. Worth doing only if
ingestion volume grows to where classification cost or latency is visible.
