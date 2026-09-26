# Contract: domain events

Published through the transactional outbox (012 FR-031), so a consumer never observes a transition
that was rolled back. Every event carries `tenantId`, `issueId`, `correlationId`, `occurredAt` and
a schema version.

## Naming discipline

Past-tense names describe **facts**. A proposal is not a fact and is named accordingly
(`…Proposed`), because only facts may be replayed or aggregated.

One naming rule carries real weight: **an automated resolution means verified in production**, not
merged and not deployed. If `IssueResolved(fixed)` fired on merge, 009 would tell every waiting
reporter the problem is fixed while verification is still running. The one kind that carries no
verification is `self_resolved`, published when a human closes the issue — and it is precisely the
kind no consumer may treat as verification (C-09, see below).

## Events this feature publishes

The **Consumed by** column names the features that reference the event today. An event with no
consumer is published anyway — it is a fact about an issue — but the column does not claim a reader it
does not have; a phantom consumer is how an event contract drifts into fiction.

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `IssueDetected` | a signal creates a new issue | kind, component, severity, fingerprint | 003, 009 |
| `IssueReopened` | matching signal inside the reopen window | previousState, signalRef | 003, 009 |
| `IssueRecurred` | matching signal outside the window | newIssueId, recurrenceOfId | 009 |
| `IssueRelated` | deterministic correlation linked two issues (FR-020) | otherIssueId, rule | dashboard |
| `IssueStateChanged` | any transition | fromState, toState, cause, actorRef | 002, dashboard |
| `EvidenceRecorded` | evidence written | evidenceId, type, producedByStep | none today |
| `EvidenceDetached` | source became unavailable | evidenceId, sourceLabel | dashboard |
| `IssueMerged` / `IssueUnmerged` | merge or its reversal | intoIssueId, reason | dashboard |
| `IssueStale` | no signals and no progress for the configured window | lastProgressAt | dashboard |
| `IssueResolved` | the issue is resolved — see the resolution kinds below | resolutionKind (`remediated` · `fixed` · `self_resolved`), verifiedAt?, verificationEvidenceIds | 009 |
| `IssueDeleted` | tenant-requested deletion | tombstoneId — no content | audit |

### `IssueResolved` and its three kinds

| `resolutionKind` | Published when | Verification evidence |
|------------------|----------------|-----------------------|
| `remediated` | `RemediationVerified` from 010 | present |
| `fixed` | `ChangeVerifiedInProduction` from 008 — **reserved, no emitter in v1** (C-09, 008 R-25) | present |
| `self_resolved` | **a human closes the issue** (FR-021) | **empty** — nobody verified anything |

`self_resolved` has a producer, and it is a person. It exists because the commonest real ending is an
engineer fixing it themselves, and an issue that ends that way must still leave the lifecycle rather
than sit open forever.

**009 releases a held ticket only on `resolutionKind ∈ {remediated, fixed}` with non-empty
verification evidence; `self_resolved` escalates** (C-09). Releasing on it would send every waiting
reporter a draft citing verification evidence that does not exist (009 FR-018).

## Events this feature consumes

| Event | From | Effect |
|-------|------|--------|
| `ContextCollected` | 003 | state → `investigating`; collection gaps recorded as evidence |
| `DiagnosisCompleted` | 006 | state → `diagnosed` or `needs_human` |
| `RemediationVerified` | 010 | state → `resolved` with `resolutionKind = remediated`, **carrying the verification evidence identifiers** — 009 releases held tickets only on a non-empty set |
| `RemediationUndone` | 010 | the issue reopens; the undo and its trigger are recorded |
| `RemediationEscalated` | 010 | state → `needs_human`, carrying the attempt history and the reason no further attempt will be made |
| `ChangeVerifiedInProduction` | 008 — **not emitted in v1** (C-09) | state → `resolved` with `resolutionKind = fixed`. Reserved: at L2 Healer neither merges nor deploys, so it never observes its own change in production. In v1 `resolved` is reached only through `RemediationVerified` or a human close |
| `PolicyDecisionRecorded` | 002 | audit entry linked to the issue |

## Delivery guarantees

- At-least-once. Consumers are idempotent by `(eventId, consumer)`.
- Ordering is guaranteed per issue, not globally.
- A consumer that cannot process an event retries with backoff and lands in a dead-letter queue;
  the dead letter is itself observable, because a silently stuck consumer looks exactly like a
  quiet system.
