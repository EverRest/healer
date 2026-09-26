# Runbook: a customer's runner is misbehaving

The hybrid split (ADR 0001) means support is **blind by design**: we cannot read the customer's logs,
source or payloads. This runbook exists because "please send us the logs" is not an available step and
never will be.

## What we can see

| Available | Not available, ever |
|-----------|---------------------|
| Runner registration: protocol version, image version, declared capabilities, resource limits | Log bodies |
| Heartbeat history and gaps | Source file contents |
| `runner_capability_resolution` — every degrade and refuse, with its reason | Request or response payloads |
| Structured evidence that crossed, by shape and size | Environment variables, secrets |
| Ingress validation rejections: digest plus schema-error paths | Anything in the withholding ledger |
| The diagnostic bundle (012 R-06) | Customer personal data |

The diagnostic bundle is the customer-side command: `make runner-diagnostics`. It contains versions,
capability set, configuration reduced to **presence-only**, queue depths, timing histograms, the
runner's own error signatures, and the last N exchanges with payloads replaced by schema identifier
and size.

## Triage

### 1. Is the runner connected?

Check `runner_registration.last_heartbeat_at` and `status`.

| Status | Meaning | Action |
|--------|---------|--------|
| `active` | Healthy | Look further down this list |
| `degraded` | Read-only capability missing — collection proceeded with gaps | Read `runner_capability_resolution`; the gap names the capability. Usually an older image |
| `refused` | Below the compatibility floor — two minor versions or ninety days | `refused_reason` states the required version. Nothing will work until they upgrade |
| No heartbeat | Unreachable or stopped | Issues stay open; work needing the execution plane is not attempted and the reason is recorded. No partial execution happened |

### 2. Is work being refused rather than failing?

A **refusal is not a bug**. State-changing capabilities refuse rather than degrade, on purpose: a
mutation executed by older logic without warning is the failure this product cannot have (C-02).

Look for refusals in `runner_capability_resolution` where `outcome = 'refused'`. Each carries the
capability and the reason. The fix is almost always a runner upgrade.

### 3. Are evidence items missing?

Every non-collected source produces exactly one `collection_gap`. Read the gaps before assuming a
collection bug — most "missing evidence" is a recorded, intended gap:

| Gap reason | Meaning |
|------------|---------|
| `redaction_withheld` | The redactor could not clear the item. **Working as designed.** The original is resolvable only on their side, via `make runner-resolve-ref <uuid>` |
| `capability_unavailable` | The runner lacks that collector |
| `timed_out` | Source did not answer inside its budget |
| `budget_exhausted` | Tenant budget stopped further collection |
| `schema_rejected` | The payload failed boundary validation and was **not** stored — only its digest and the failing schema paths |
| `not_attempted` | The plan did not include this source |
| `empty_result` | The source answered, with nothing |

### 4. Is the outbound buffer dropping?

On loss of connectivity the runner buffers, then drops **oldest first** and records a
`collection_gap` for what it dropped. This is lossy-with-a-record, and it is deliberately different
from control-plane ingestion, which does not lose events. A run of drop gaps means connectivity, not
a collection defect.

### 5. Is a job stuck?

Jobs never wait (ADR 0003), so a stuck workflow is a missing callback, not a hung worker. Check:

- `workflow_run.awaiting` — what it is waiting for, and its deadline
- `workflow_callback` — issued, consumed, `received_count`
- The periodic stuck-run check reports any non-terminal run with neither a pending callback nor a
  deadline. That combination is a defect; the others are waiting correctly.

## Asking the customer for something

Only these are reasonable to request, because only these contain nothing we are not allowed to hold:

1. `make runner-diagnostics` output
2. The runner image version and protocol version
3. Whether an upgrade is available to them
4. For a withheld item: their own resolution of the local reference, if *they* choose to look

Never ask for logs, environment files, a source snippet or a payload. If a diagnosis genuinely
requires one of those, the diagnostic bundle is missing a structured fact it should carry — that is a
bug in the bundle, and it is the right bug to fix.

## Escalation

If the bundle cannot explain the behaviour, the gap is in our observability rather than in their
environment. File it against 012 FR-024 with what the bundle did not tell you. Blind support only
works if the bundle keeps earning it.
