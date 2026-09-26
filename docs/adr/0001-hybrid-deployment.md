# ADR 0001: Hybrid deployment — our control plane, their execution plane

## Status

Accepted — 2026-09-23

## Context

Healer is a product sold to other companies (D-01). It needs production logs, repository access and
the ability to run a customer's test suite. Full SaaS means customer source code, logs and test
secrets all cross into our infrastructure — simple to build, and a reliable way to lose enterprise
deals at security review. Fully self-hosted means no telemetry, blind support and no ability to
improve across customers.

## Decision

Split the planes.

```text
CONTROL PLANE (ours)              EXECUTION PLANE (customer's)
Issues, evidence, audit           Repository checkout
Policy engine                     Sandbox, test execution
Agent orchestration               Code intelligence
                                  Model calls over source (ADR 0010)
Knowledge index                   Log collection + redaction
Dashboard, simulator              Remediation actions
```

**What crosses the boundary is a contract**, enforced and tested: normalised error signatures,
trace shapes, metric deltas, file paths, test results. Never raw log bodies.

## Consequences

- \+ Customer source and secrets stay in their network; most procurement objections dissolve.
- \+ The secrets problem largely disappears — the sandbox needs no production credentials.
- − The Context Resolver becomes a distributed component; redaction must happen on their side.
- − The runner is a shipped product: versioned, upgradable, health-reported, and **debuggable by us
  without seeing their data**.
- − No cross-customer benchmark. The golden dataset must come from a design partner (D-04).
- **Honest limit**: source code still reaches a model provider when the change agent runs. Since
  ADR 0010 it does so from the customer's network and never through ours; keeping the repository
  inside their network does not change what is in the prompt. See ADR 0006.
