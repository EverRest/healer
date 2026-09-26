# Contract: domain events

Published through the transactional outbox (001 FR-014, 012 FR-031), each in the same transaction as
the state it describes, so a consumer never observes a transition that was rolled back. Every event
carries `tenantId`, `correlationId`, `occurredAt` and a schema version; every event except
`RemediationCataloguePublished` also carries `issueId`.

## Naming discipline

Past-tense names describe **facts** (001 `contracts/events.md`). `RemediationProposed` is the one
`…Proposed` name here, and it is a fact about a proposal, not a claim that anything ran.

Two names carry the weight of this feature:

- **`RemediationVerified` means a verification window closed `improved`** against an anchor that
  pre-dates the issue (FR-005, R-03) — never that the runner reported success. It is what 001 turns
  into `IssueResolved(resolutionKind = remediated)`, and 009 releases held tickets on that. If it
  fired on a dispatch result, 009 would tell fifty reporters their problem is fixed on the strength of
  the action's own report of itself.
- **There is no `RemediationSucceeded` and no `IssueResolved` published here.** A verified remediation
  is a *mitigation* (FR-017, R-11); resolution belongs to 001, and for an issue classified as a code
  problem there is none. The event set has no member that could close a code problem.

## Events this feature publishes

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `RemediationProposed` | an attempt row reaches `proposed` with a policy decision requested | attemptId, actionKey, targetRef, catalogueVersionId, parameters, blastRadius, issueFingerprint, justificationEvidenceIds, policyDecisionId?, mode | 002 (audit link), 011, dashboard |
| `RemediationDispatched` | the directive left the control plane, after `prior_state` and `undo_directive` were persisted | attemptId, invocationId, actionKey, targetRef, priorState, undoDirective, revisionRefAtDispatch, verificationWindowId | 011, dashboard |
| `RemediationVerified` | a verification window closed `improved` | attemptId, targetRef, issueFingerprint, anchorKind, anchorRef, baselineValue, observedValue, **verificationEvidenceIds**, timeToVerifiedRemediationMs, mitigation (always true) | **001** (state → `resolved` with `resolutionKind = remediated`, 001 `contracts/events.md`), 011, dashboard |
| `RemediationUndone` | the stored undo directive was dispatched and restored the prior state | attemptId, trigger (`not_improved` · `inconclusive` · `external_change` · `human`), undoActionKey, stateBefore, stateAfter, observed, evidenceIds | **001** (issue reopened, FR-006), 011, dashboard |
| `RemediationEscalated` | an undo failed, an external change invalidated a verification, or the attempt cap was reached | attemptId?, targetRef, reason (`undo_failed` · `external_change` · `attempt_cap` · `inconclusive_unrecoverable`), observedState, observed, attemptHistory, recurrenceIntervals, evidenceIds, targetBlockId? | **001** (state → `needs_human`, R-16), dashboard, 011 |
| `RemediationCataloguePublished` | a release publishes a new catalogue content digest | catalogueVersionId, digest, actionKeys, buildRef, undoAttestations (per action key: test run identifier, result, executedAt) | **002** (re-derives `reversible` and `hasTestedUndo` for the action registry, 002 `contracts/evaluation.md`), dashboard |

`RemediationCataloguePublished` is the only event here that is not tenant-scoped: the catalogue is the
product, not a tenant's configuration (data-model `remediation_catalogue_version`). Its
`undoAttestations` payload is the **sole** source of 002's `hasTestedUndo`, which under C-18 is what
gives `reversible_remediation` an autonomy level at all — so a release that drops an attestation
lowers the ceiling rather than leaving a stale permission behind (R-02, R-14).

## Events this feature consumes

| Event | From | Effect |
|-------|------|--------|
| `DiagnosisCompleted` | 006 | supplies the diagnosis or correlation evidence a proposal must reference (FR-018) |
| `PolicyDecisionRecorded` | 002 | the decision an `execute` attempt is bound to, with its rule version and reason codes |
| `ApprovalResolved` | 002 | a `REQUIRE_APPROVAL` attempt leaves `awaiting_approval`; a rejection refuses it |
| `ApprovalExpired` | 002 | the attempt is refused (002 FR-016) |
| `AutonomyRevoked` | 002 | the guarded step stops at the next evaluation; no push mechanism is needed |
| `IssueStateChanged` | 001 | an attempt bound to an issue in a terminal state is refused rather than dispatched |

## Explicitly not published

`IssueResolved` — 001 owns it, and a remediation never closes a code problem (FR-017, R-11).
`RemediationSucceeded` — the dispatch result is not a verification (FR-005, R-03).

## Delivery guarantees

- At-least-once. Consumers are idempotent by `(eventId, consumer)` (012 FR-028), and the mutating side
  is additionally idempotent by `invocation_id` (FR-010).
- Ordering is guaranteed per issue, not globally. Per target, ordering is enforced by the unique
  partial index rather than by the bus (R-07).
- A consumer that cannot process an event retries with backoff and lands in a dead-letter queue, which
  is itself observable.

## Cross-spec notes

- 001's `IssueResolved` payload must carry the verification evidence identifiers it received on
  `RemediationVerified`, because 009 releases a held ticket only on a non-empty set (009 FR-018, C-09).
- 001 must consume `RemediationUndone` (issue reopened) and `RemediationEscalated` (state →
  `needs_human`); its consumed list currently names only `RemediationVerified`.
