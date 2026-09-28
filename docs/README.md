# Docs index

| Document | Covers |
|----------|--------|
| [roadmap.md](roadmap.md) | Stages, spec state, v1 shape |
| [stage-0.md](stage-0.md) | Blockers before specs can be planned |
| [decisions.md](decisions.md) | Decision record from the design conversation |
| [changelog.md](changelog.md) | Versioned history; `VERSION` carries the current number |
| `adr/` | Architecture decision records (below) |
| [patterns.md](patterns.md) | Techniques that recur across specs, and when to reach for them |
| [domain/glossary.md](domain/glossary.md) | Terms crossing spec boundaries, and the spec that owns each |
| [workflows/investigation-pipeline.md](workflows/investigation-pipeline.md) | How the thirteen features compose, and what holds each seam |
| [runbooks/runner-diagnosis.md](runbooks/runner-diagnosis.md) | Triaging a customer's runner without seeing their data |
| [runbooks/raising-autonomy.md](runbooks/raising-autonomy.md) | The procedure for raising an autonomy ceiling, and what each refusal means |
| [security-posture.md](security-posture.md) | The procurement and security-review document; a consolidation of ADR 0001, ADR 0006 and the runner protocol |
| [boundary-exceptions.md](boundary-exceptions.md) | The only form a boundary-rule exception takes — a recorded row, never an inline suppression (012 T077) |

Principles live in [.specify/memory/constitution.md](../.specify/memory/constitution.md).
Agent instructions in [AGENTS.md](../AGENTS.md).

## ADRs

| ADR | Decision |
|-----|----------|
| [0001](adr/0001-hybrid-deployment.md) | Hybrid deployment — our control plane, their execution plane |
| [0002](adr/0002-evidence-and-anti-circularity.md) | Evidence as substrate; verification that cannot close a circle |
| [0003](adr/0003-bullmq-never-wait-in-a-job.md) | BullMQ, and never wait inside a job |
| [0004](adr/0004-postgres-for-graphs-and-retrieval.md) | Postgres for graphs and retrieval |
| [0005](adr/0005-mcp-outward-only.md) | MCP is an outward-facing surface, not internal plumbing |
| [0006](adr/0006-per-tenant-llm-provider.md) | Per-tenant LLM provider configuration |
| [0007](adr/0007-component-not-service.md) | Model `Component`, not `Service` |
| [0008](adr/0008-capability-passing.md) | Capability passing for irreversible operations |
| [0009](adr/0009-derivation-artifacts-and-diff-gates.md) | Derivation artifacts, and gating a diff rather than data |
| [0010](adr/0010-inference-follows-the-source.md) | Inference follows the source — model calls over customer source run in the runner |
| [0011](adr/0011-agent-driven-development.md) | Agent-driven development under the same gates |
| [0012](adr/0012-openapi-contract-generation.md) | OpenAPI generated via `@nestjs/swagger` |
| [0013](adr/0013-prisma-client-workspace-package.md) | A dedicated `@healer/prisma-client` workspace package |
| [0014](adr/0014-runner-artifact-build-and-versioning.md) | Runner artifact build, versioning and packaging |
