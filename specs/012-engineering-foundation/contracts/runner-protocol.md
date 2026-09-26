# Contract: control plane ↔ runner

The boundary defined by ADR 0001. **This document is also what a customer's security review reads**,
so it states what crosses in both directions and what cannot.

## Direction and initiation

The runner initiates every connection outbound. The control plane never connects into the
customer's network and needs no inbound firewall rule — that requirement alone kills deals.

The runner has exactly two outbound destinations: the control plane, and the tenant's model provider
endpoint for runner-side inference (ADR 0010). The sandbox it starts has neither — default-deny egress
is unchanged.

## Registration and heartbeat

The runner declares, at registration and on every heartbeat:

```text
protocolVersion   integer
imageVersion      string
capabilities      string[]      # declared, not inferred
resourceLimits    { cpu, memoryMb, maxConcurrentRuns }
```

The control plane replies with the resolved capability set — the intersection — and a status of
`active`, `degraded` or `refused`.

## Compatibility (C-02, R-03)

| Situation | Outcome |
|-----------|---------|
| Capability present on both sides | used normally |
| Read-only capability missing on the runner | **degrade explicitly**: the work proceeds, the gap is recorded as a collection gap, and the resolution is stored in `runner_capability_resolution` |
| State-changing capability missing on the runner | **refuse** with a stated reason. Never degrade — a mutation executed by older logic without warning is the failure this product cannot have |
| Protocol older than two minor versions, or older than ninety days | **refuse the runner entirely**; report the required upgrade |

## What may cross — from runner to control plane

A closed list (R-04). The schema is versioned and rejects free-form string fields; anything not in
this list is not transmitted.

| Shape | Contents |
|-------|----------|
| `error_signature` | normalised exception type, normalised frames, component, environment — no message bodies |
| `trace_shape` | span names, durations, service edges, status codes — no attributes carrying payload |
| `metric_delta` | series identifier, window, baseline, observed, direction |
| `deploy_ref` | deployment identifier, version, time, component |
| `commit_ref` | commit SHA, author handle, time, changed paths — not diff content |
| `test_result` | test identifier, outcome, duration, failure signature — not stdout |
| `file_path` | repository-relative path — not file content |
| `tool_output_summary` | tool name, outcome, structured fields declared by that tool |
| `collection_gap` | what was not collected, why, and whether it was withheld by redaction (R-05) |
| `component_candidate` | discovered component: identifier, type, characteristics, source of the observation (004) |
| `deployment_unit_candidate` | discovered deployment unit: identifier, version, component references |
| `dependency_observation` | observed edge: from, to, kind, provenance, observation count and window |
| `repository_ref` | repository identifier, default branch, component mapping — not contents |
| `pull_request_ref` | pull request identifier, source and target branch, state, review state, author handle, time, changed paths — not description text, not comment bodies, not diff content (008) |
| `config_key_ref` | configuration key path, the declaring component, environment, value **presence and shape only** (`present` · `absent`, type, length class) — never a value (003) |
| `knowledge_ref` | document identifier, repository-relative path, section anchor, content digest, revision, authorship class (`human` · `machine` · `machine_adopted`), observed-at — not document text (005) |
| `stack_frame` | repository-relative path, symbol name, line number, frame index — not the source line's text (003). `file_path` carries a path alone; a frame is a path **plus** where in it, and conflating the two would have let symbol names ride inside a shape declared as "path only" |
| `change_plan_proposal` | the change agent's plan for policy (008 FR-004): primary files, dependent files, test paths as repository-relative paths, impact class, `ExpectedBehavior` reference — not patch content |
| `masking_candidate` | repository-relative path, hunk line range, masking class from 008 FR-014's closed list — not the hunk |
| `verification_verdict` | verdict from 008 FR-017's vocabulary, anchors available and used as enumerations with evidence references — not the verifier's reasoning |
| `test_binding_ref` | test identifier, repository-relative path, expectation identifier and version, read from the test's `@expectation` annotation — not test content (013 R-06) |
| `agent_run_report` | agent kind, model identifier, provider, prompt version identifier, input and output token counts, cost, tool names with argument digests and outcomes, decision-path step identifiers, outcome enumeration, duration — no prompt, no model input or output (012 FR-033) |
| `change_graph` | impact nodes and edges: repository-relative paths, symbol names, `relation`, `derivation` (`ast` · `type_graph` · `call_graph` · `contract` · `migration` · `test` · `event_consumer` · `feature_flag`) — not patch content, not file contents (008) |

**Never crosses**: raw log bodies, request or response payloads, file contents, patch content, model
inputs and outputs of runner-side agents, environment variables, secrets, customer personal data,
database rows.

**Every fact family gets its own declared shape** (C-20). Graph facts, pull requests, configuration
keys and knowledge documents do not travel inside `tool_output_summary`: reusing that shape would
reopen the free-form channel this contract exists to close (R-04), and a closed list with one
general-purpose escape hatch is not closed. A new family is a new row in this table plus a versioned
schema — a change to this document, reviewed like the rest of it.

Where a redactor cannot establish that an excerpt is safe, the item is **withheld and a
`collection_gap` is recorded** — never truncated and sent best-effort (R-05).

## What may cross — from control plane to runner

| Shape | Contents |
|-------|----------|
| `collection_plan` | which declared collectors to run, over which window, for which components |
| `reproduction_directive` | ladder rung, target, declared test command, limits (007) |
| `agent_directive` | agent kind, prompt version identifier **and digest**, input references (issue, diagnosis, reproduction, anchor), budget in tokens, cost and wall-clock, tool scope (ADR 0010) |
| `prompt_version` | prompt text and parameters by identifier; the runner refuses it unless its digest matches the directive's (012 FR-038, FR-039) |
| `change_plan` | the **approved** plan: files permitted to change, regression test location, anchor reference, limits — not a patch; the patch is written in the runner and never crosses (008) |
| `remediation_directive` | action key, target, parameters from the declared catalogue (010) |
| `capability_query` | handshake |

### The simulation session is a restricted directive set (C-10)

A session opened for a simulation run (011) may carry `collection_plan`, `reproduction_directive`,
`change_plan` and `agent_directive` for the `change` and `verifier` kinds (ADR 0010 — the candidate patch
is written in the runner), all scoped to a sandbox workspace. It may **not** carry `remediation_directive`,
and the session holds no repository-write capability (ADR 0008).

`change_plan` is admitted because otherwise `false_fix_rate` — the number the constitution defers L3
on — is unmeasurable: RED and GREEN cannot be observed without applying a patch somewhere. The
workspace is destroyed when the run ends and holds no credentials (007), so the mutation the
capability model exists to prevent is still absent.

The control plane never sends a shell command. Every directive names a declared action with
schema-validated parameters.

### Runner-side inference (ADR 0010)

`inference` is a declared capability. Without it, every `agent_directive` is refused with the reason —
the change agent's path changes state, so it cannot degrade (C-02, C-35). Provider credentials are
resolved from the customer's secret manager: the customer's own account for a customer-supplied tenant,
a per-tenant Healer-issued, spend-limited key otherwise (C-34). No credential of any kind is carried by
a directive.

A runner-side agent stops at its directive's budget, and the provider key's own limit stops it if the
directive's does not. Everything it returns is one of the shapes above; a field an agent would fill with
prose has no shape to travel in.

## Diagnostics (R-06)

`make runner-diagnostics` produces a bundle for support: versions, capability set, configuration
with values reduced to presence-only, queue depths, timing histograms, the runner's own error
signatures, and the last N exchanges with payloads replaced by schema identifier and size.

No customer data, no source, no log bodies. Support is blind by design; this is what makes it
workable anyway.

## Failure behaviour

- Control plane unreachable → the runner buffers outbound evidence up to a bounded size, then drops
  oldest first and records a `collection_gap` for what was dropped. It never blocks the customer's
  systems. This buffer is **lossy with a record**, which is deliberately weaker than control-plane
  ingestion durability (001 FR-019): an unbounded buffer would eventually take the customer's system
  down, so the honest outcome at the bound is a gap that is visible, not a promise of no loss
  (FR-021).
- Runner unreachable → issues remain open; work requiring the execution plane is not attempted and
  the reason is recorded. No partial execution.
- A directive arrives twice → execution is idempotent by directive identifier.
