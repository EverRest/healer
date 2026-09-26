# Security posture

> **The customer-facing version of this page is [docs/security-posture.md](../../docs/security-posture.md)**
> — the document procurement and a security review actually read, consolidated from ADR 0001, ADR 0006,
> ADR 0010 and 012's runner protocol. This page is the reasoning behind it and stays research-side. Two divergent posture
> documents is the failure this note exists to prevent: when the reasoning changes, change it here **and**
> there, or delete whichever is stale.

Healer is, by design, a system with production read access and repository write access, whose
reasoning input is partly attacker-influenceable. That combination is unusual and procurement will
notice it before we do.

## The hybrid boundary

```text
HEALER CONTROL PLANE              CUSTOMER EXECUTION PLANE
Issues, evidence, policy          Repository checkout
Agent orchestration               Sandbox, test execution
Knowledge index                   Code intelligence
Dashboard, simulator, audit       Log collection + redaction
                                  Remediation actions
                                  Model calls that read source (ADR 0010)
```

**What crosses is a contract, not a convenience.** The runner sends structured evidence —
normalised error signatures, trace shapes, metric deltas, file paths, test results. It does not
send raw log bodies. If raw logs cross, hybrid deployment bought nothing and we have taken on
their PII.

## The honest limit of the boundary

Source code still reaches a model provider when the change agent runs — keeping the repository
inside their network does not change what is in the prompt. Three positions, in increasing
strength:

1. Code reaches the provider, is never stored by us — the Copilot/Cursor posture
2. **Customer brings their own model access** (Bedrock, Vertex) under contracts they already
   signed — the strongest enterprise answer, and the reason provider configuration is per-tenant
3. Local models — currently not capable enough for this work

Claiming (1) while implying (2) is the kind of thing that ends a security review badly.

### The crossing nobody had described (2026-09-26)

Until ADR 0010 the design contained a quiet contradiction. The runner contract said file contents never
cross; the posture said source is in the change agent's prompt; the change agent lived in the control
plane. Both statements could only be true through a path that no specification described — source text
travelling runner → control plane → provider, with no shape, no bound and no reader. It was found by
asking a plain question about where the runner runs and what it sends, not by any review pass.

The resolution is a rule rather than a patch: **a model call runs where its inputs live.** The change
agent, the applier, the masking analyser and the verifier run in the runner and call the tenant's
provider from the customer's network. Position (1) above becomes stronger than it sounds — code reaches
the provider and **never passes through Healer at all** — and position (2) gains the most: a BYO
tenant's code reaches only the provider they contracted with, with no hop of ours in between.

The price is paid in two places. The runner needs one more outbound destination (the provider), and for
Healer-managed tenants a provider key sits in the customer's infrastructure — per tenant, spend-limited,
revocable, rotated by hand through their secret manager (C-34, C-38). A shared key or a Healer
inference proxy were both rejected: the first is one leak away from every tenant's spend, the second
brings the source straight back through us.

### What else follows from the same rule

- **Embeddings.** Embedding a customer document is a model call over content that does not cross, so in
  v1 there is no vector index over customer documents at all (C-36). Vectors are derived content and
  partly invertible; they are not a free way around the contract.
- **Model output is a channel.** A runner-side agent's structured output returns only as closed shapes;
  a field an agent would fill with prose has no shape to travel in. Explanatory prose generated from
  source stays in the customer's pull request.
- **Our own telemetry.** Traces and logs leave our processes with a keyed hash of the tenant identifier,
  not the identifier, so an operator browsing a hosted telemetry backend cannot see whose investigation
  they are looking at without asking the application, which audits the question (C-41, 012 FR-037).

## Prompt injection through evidence

Logs, support tickets, PR descriptions and commit messages are written, directly or indirectly, by
people outside the customer's organisation. They flow into an agent that can open pull requests.
An attacker who can get a string into a log line is attempting to reach a code-writing system.

Structural mitigations, not prompt instructions:

- retrieved content is data, never instructions
- the agent proposes a patch; a separate privileged step commits it
- the sandbox holds no repository credentials
- tool invocations are schema-validated and audited

## Sandbox

Runs the customer's test suite plus model-generated code. Container isolation alone is the floor,
not the ceiling.

- **Default-deny egress.** A test suite with internet access can exfiltrate the source tree. This
  matters more in practice than container escape.
- No production credentials, ever.
- CPU, memory, process and wall-clock limits; workspace destroyed after each run.
- Stronger isolation (gVisor, Kata, Firecracker) where tenants share hardware.

## Tenant isolation

`tenantId` is a mandatory query parameter enforced at the data layer. Not a filter applied after
retrieval, not an instruction in a system prompt. Retrieval crossing tenants is the failure that
ends the company, and it is one weak `WHERE` clause away at all times.

## Audit

Every agent action records actor, action, reason, evidence, model, prompt version, tools used,
files touched, tests run, policy decision and outcome. This is not only for us — it is what a
customer's change-management process reviews, and in regulated industries it is what makes the
product adoptable at all.
