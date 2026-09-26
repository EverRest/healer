# Healer security posture

**Audience: a customer's security review and procurement.** This document is a consolidation, not new
material. Its sources are [ADR 0001](adr/0001-hybrid-deployment.md),
[ADR 0006](adr/0006-per-tenant-llm-provider.md), [ADR 0010](adr/0010-inference-follows-the-source.md), 012's
[runner protocol](../specs/012-engineering-foundation/contracts/runner-protocol.md) — the authority for
the boundary list — and the [research posture note](../research/wiki/security-posture.md). Where this
document and the runner protocol disagree, the protocol is correct.

## What Healer is, stated plainly

A system with production read access and repository write access, whose reasoning input is partly
written by people outside your organisation. That combination is unusual, and you will notice it whether
or not we point at it. The rest of this document is what we do about it.

In this release Healer **never merges**. It opens pull requests and executes a closed catalogue of
reversible production actions where you have granted that specific permission for that specific
component and environment. A human merges, always. That is not a configuration default — the permission
model has no level for merge to occupy.

## Where your source code goes — the honest limit first

**Your source code reaches a model provider when the change agent runs.** Keeping the repository inside
your network does not change what is in the prompt. *"The code never leaves"* would be false, so we do
not say it.

**It never passes through Healer.** Every model call that reads your source — the change agent, the
inspection of its diff for masked failures, the verifier — runs inside the runner in your network and
calls the provider from there. What returns to us is paths, enumerations, test results and token
counts. The patch reaches people only as a pull request in your own repository host
([ADR 0010](adr/0010-inference-follows-the-source.md)). The runner therefore needs outbound access to
one more endpoint: your tenant's model provider.

Three positions, in increasing strength:

1. Code reaches the provider and is never stored by us — the posture of the coding assistants already in
   your organisation.
2. **You bring your own model access** — your Bedrock or Vertex account, your key, your agreement with
   the provider. Inference then happens under contracts you have already signed and reviewed. This is
   the reason provider configuration is per-tenant from the first release rather than an enterprise
   retrofit.
3. Local models — not capable enough for this work today. We will say so rather than offer it.

Two data-processing shapes follow, and which one applies is your choice:

| | Default | Bring your own model access |
|---|---|---|
| Who contracts with the provider | Healer, as your sub-processor | you, directly |
| Where the transfer clause lives | our agreement with you | your existing provider agreement |
| Onboarding | one contract | your provider account, configured per tenant |
| Cross-customer benchmark comparability | yes | no — results are per provider and model version |

## The boundary

Two planes. Yours holds everything that touches your code, your logs and your credentials.

```text
HEALER CONTROL PLANE              YOUR EXECUTION PLANE
Issues, evidence, audit           Repository checkout
Policy engine                     Sandbox, test execution
Agent orchestration               Code intelligence
Knowledge index                   Log collection + redaction
Dashboard, simulator              Remediation actions
```

**The runner initiates every connection outbound.** The control plane never connects into your network
and needs no inbound firewall rule.

### What crosses, as a closed list

The runner sends structured evidence and nothing else. The list is closed, the schemas are versioned,
and free-form string fields are rejected rather than sanitised: normalised error signatures, trace
shapes, metric deltas, deploy and commit references, test results, repository-relative file paths and
stack frames, tool output summaries, collection gaps, discovered component, deployment-unit and
dependency candidates, repository and pull-request references, configuration key references carrying
**presence and shape only**, knowledge document references carrying digests rather than text, and impact
graph nodes and edges.

**Never crosses:** raw log bodies, request or response payloads, file contents, environment variables,
secrets, personal data, database rows.

Each fact family has its own declared shape, and there is no general-purpose shape a new fact can be
smuggled inside. A closed list with one escape hatch is not closed. Adding a family is a change to the
protocol document, reviewed like the rest of it.

Where your redactor cannot establish that an excerpt is safe, the item is **withheld and recorded as a
gap** rather than truncated and sent best-effort. A visible gap is a better artifact than a sanitised
payload nobody can audit.

## Prompt injection, and why we do not answer it with prompt instructions

Logs, support tickets, pull-request descriptions and commit messages are written, directly or
indirectly, by people outside your organisation. They flow into a system that can open pull requests. An
attacker who can place a string in a log line is attempting to reach a code-writing agent.

The mitigations are structural, because an instruction telling a model to ignore instructions is not a
control:

- Retrieved content is data, never instructions — at every retrieval path, not as a convention.
- The agent proposes a patch; a separate privileged step commits it, and that step takes a capability
  the agent's execution context does not hold.
- The sandbox holds no repository credentials.
- Tool invocations are declared, schema-validated and audited per call. No agent has raw shell access.
- Model-reported confidence is never a permission predicate. Permission decisions use structural facts
  only, and the decision path contains no model call.

## Sandbox

It runs your test suite plus model-generated code. Container isolation is the floor.

- **Default-deny egress.** A test suite with internet access can exfiltrate a source tree; in practice
  this matters more than container escape.
- No production credentials, ever.
- CPU, memory, process and wall-clock limits. The workspace is destroyed after each run.
- Stronger isolation (gVisor, Kata, Firecracker) where tenants share hardware.

## Tenant isolation

`tenantId` is mandatory in every query and every retrieval, enforced at the data layer — not a filter
applied after retrieval, and not an instruction in a prompt. A request for another tenant's data returns
not-found rather than forbidden, because the distinction itself leaks. Every endpoint ships with a test
asserting this, enforced by a build gate that fails when an endpoint lacks one.

## Audit, and what your change-management process can read

Every agent action records actor, action, reason, evidence, model, prompt version, tools used, files
touched, tests run, policy decision and outcome. Every claim about cause, impact or resolution carries
evidence records, and those links are written by the step that produced them — never reconstructed
afterwards by a model explaining itself. A conclusion with no evidence link cannot be persisted; the
schema has no nullable column for it.

Prompt versions are immutable and resolvable: a decision from a year ago can be reconstructed rather
than re-narrated.

A Healer operator reading your traces or run records is itself written to the audit trail.

## Support without seeing your data

Diagnostics produce versions, the capability set, configuration with values reduced to presence-only,
queue depths, timing histograms, the runner's own error signatures, and the last exchanges with payloads
replaced by schema identifier and size. No customer data, no source, no log bodies. Our support is blind
by design, and the runbooks are written for that.

## What we do not claim

- We do not claim the code never leaves your network. See the first section.
- We do not claim a fix is verified in production. In this release Healer does not observe your
  production after a merge; a pull request is evidence that gates passed, not that the incident is over.
- We do not claim autonomy improves on its own. Raising it requires measured evidence, and a change that
  raises the permission ceiling fails the build unless it cites that evidence in a form the build can
  resolve.
- We do not send customer-facing text. Support answers are drafted and handed to your systems; Healer has
  no outbound send path, and a build gate fails if one is added anywhere in the repository.
