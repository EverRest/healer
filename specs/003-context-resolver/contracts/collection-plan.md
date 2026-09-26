# Contract: collection plan and result batch

What rides inside the two envelopes 012 already defines: `collection_plan` going out to the runner,
and the closed evidence shapes coming back. **This document does not restate
[012 `contracts/runner-protocol.md`](../../012-engineering-foundation/contracts/runner-protocol.md)**
— that contract governs direction, initiation, compatibility and the closed crossing list, and this
one conforms to it. Where the two disagree, the runner protocol wins (R-03).

Both sides validate against the same schema package, `packages/boundary-contract`, executed
independently at egress and at ingress (012 FR-022, R-02).

## Control plane → runner: `collection_plan`

```text
passId                uuid
issueRef              uuid              # correlation only; the runner stores no issue state
planDigest            string            # content hash of the requested plan (R-05)
contractVersion       integer
window                { from, to }      # observed-time bounds, resolved centrally
collectors            CollectorRequest[]
budget                { maxWallClockMs, maxItemsPerCollector }
redactionRulesetVersion integer
```

```text
CollectorRequest
  collectorKey        enum              # from the registry — an undeclared source is unrepresentable
  parameters          object            # validated against that collector's declared schema
  timeoutMs           integer
  itemClasses         enum[]            # what this collector is permitted to emit
```

`collectorKey` is an **enum over the registry, never a string** (R-12). A follow-up pass requested
by a downstream step (FR-005) is the same directive with a higher `passOrdinal`, a
`requestedByStep` and an enumerated `requestReason`; it is capped per issue and audited like any
other pass.

The control plane never sends a query, an expression or a command — only a declared collector with
schema-validated parameters, which is the same rule the runner protocol states for every directive.

## Runner → control plane: result batch

```text
passId                uuid
planDigest            string            # echoed; a mismatch rejects the batch
contractVersion       integer
runnerImageVersion    string
collectedAt           timestamp         # runner clock; items carry source observed time
sourceOutcomes        SourceOutcome[]
items                 EvidenceShape[]   # the closed list of the runner protocol — nothing else
```

```text
SourceOutcome
  collectorKey        enum
  status              collected | partial | unavailable | timed_out | withheld | not_attempted
  reasonCode          enum              # see below
  itemCount           integer
  truncated           boolean
  durationMs          integer
```

One batch per pass. A duplicate batch for an ingested pass is acknowledged and dropped (R-05), the
same way 001 R-09 handles a repeated provider delivery.

### Gap reason codes (closed)

| Code | Means | Distinguishes |
|------|-------|---------------|
| `source_unreachable` | the source did not answer | infrastructure, not configuration |
| `auth_revoked` | credentials rejected | a configuration problem someone must fix |
| `timeout` | exceeded the per-source timeout | partial content may still have been kept (FR-016) |
| `retention_exceeded` | the issue predates the source's retention | a correct answer, not a defect |
| `capability_unavailable` | the runner does not declare this collector (012 R-03) | a version gap, recorded in `runner_capability_resolution` |
| `budget_exhausted` | 002 FR-011 stopped the pass | resumable, not a failure (R-15) |
| `redaction_withheld` | the redactor could not clear the item (012 R-05) | withheld, never truncated |
| `schema_rejected` | egress validation refused the payload | the runner did not send it |
| `empty_result` | the source answered with nothing | **not** the same as unavailable |

Every status other than `collected` produces exactly one `collection_gap` evidence record. That
record is what lets 006 FR-013 name specific missing evidence and still satisfy 001 FR-009 — an
absence that is not recorded is an absence nothing can cite (R-07).

## Withheld items

```text
collection_gap  (reasonCode = redaction_withheld)
  localRef            uuid              # resolves only inside the customer's plane
  itemClass           enum
  collectorKey        enum
  observedAt          timestamp
```

No excerpt, no locator we can follow, no truncated remnant. The original sits in the runner's
plane-local `withholding_ledger` and is resolved there by a human with
`make runner-resolve-ref <uuid>` (FR-009, R-08).

An item whose excerpt survives redaction but carries no remaining signal is **not** withheld: it
crosses with its structured derivatives and `redactionDominated: true`, so a reader knows to look
locally rather than concluding there was nothing there.

## Item-class crosswalk (non-normative)

The normative crossing set is the shape set of the runner protocol (FR-006, R-03). This table is a
**crosswalk**, not a second contract: it says which shape each collection item class travels as, so a
reviewer can check the collectors against the closed list. Nothing here adds to that list.

Every fact family has its own declared shape — `pull_request_ref`, `config_key_ref` and
`knowledge_ref` join the four graph shapes of 004 in 012's protocol (C-20). None of the three rides
as `tool_output_summary`: reusing that shape reopens the free-form channel the contract exists to
close.

| Collection item class | Crosses as |
|-----------------------|------------|
| normalised error signatures and occurrence statistics | `error_signature` |
| stack frame paths, symbols, line numbers | `file_path` — **see the note below**; only the repository-relative path crosses until 012 resolves it |
| trace shapes | `trace_shape` |
| metric series identities, aggregates, deltas | `metric_delta` |
| deployment metadata | `deploy_ref` |
| commit metadata and changed paths | `commit_ref` |
| test identifiers and results | `test_result` |
| pull request metadata | `pull_request_ref` (C-20) |
| configuration and feature-flag key names, value types, change indicators | `config_key_ref` (C-20) — **key names and types only, never values** (FR-007) |
| knowledge and issue references | `knowledge_ref` (C-20), identifiers only |
| bounded redacted excerpts | carried on the shape they belong to, bounded at capture (001 FR-011) |
| anything not collected | `collection_gap` |

**Open cross-spec item — stack frames.** `file_path`'s declared contents in 012 are
"repository-relative path — not file content", which has room for neither a symbol name nor a line
number. 012 must either extend `file_path`'s contents or declare a `stack_frame` shape. Until it
does, this crosswalk is what the collectors are built against: the path crosses as `file_path`, the
symbol and line number do not cross, and the gap is recorded rather than smuggled into a free-form
field.

## Ingress validation and quarantine

A batch is validated at ingress before any domain write. A non-conforming batch is rejected and
recorded as `(contractVersion, runnerId, schemaErrorPaths, payloadDigest, byteSize)` —
**the payload is not stored** (FR-010, R-13). Rejection counts are visible to the tenant and to
Healer (012 FR-022).

## Events published through the outbox (012 FR-031)

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `ContextCollected` | a snapshot is finalised | snapshotId, version, completeness, budgetState | 001 (state → `investigating`), 006, 011 |
| `ContextPassDispatched` | a pass is sent to a runner | passId, planDigest, collectorKeys | dashboard |
| `ContextDegraded` | any source outcome other than `collected` | collectorKey, status, reasonCode, gapEvidenceId | 006, dashboard |
| `ContextItemWithheld` | redaction withheld an item | localRef, itemClass, reasonCode | tenant notification, dashboard |
| `BoundaryPayloadRejected` | ingress validation refused a batch | runnerId, contractVersion, schemaErrorPaths | tenant notification, Healer alerting |

## Events consumed

| Event | From | Effect |
|-------|------|--------|
| `IssueDetected` | 001 | plan and dispatch collection pass 0 |
| `IssueReopened` | 001 | re-collect; new snapshot version, predecessor linked (FR-022) |
| `BudgetDegraded` / `BudgetExhausted` | 002 | narrow the next pass; finalise the current one as `budget_limited` (R-15) |
| `RunnerRegistered` / `RunnerStatusChanged` | 012 | resolve capabilities; dispatch passes held as `runner_unavailable` |
