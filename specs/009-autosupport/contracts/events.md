# Contract: domain events

Published through the transactional outbox (001 FR-014, 012 FR-031). Every event carries `tenantId`,
`issueId`, `correlationId`, `occurredAt` and a schema version.

## Naming discipline

`SupportAnswerDrafted` is a **fact about a draft**, not about a message. Healer publishes it and
stops; an external system or a human sends (FR-016, D-13). There is no `AnswerSent` event published
by this feature — a send is reported *to* us as an inbound fact attributed to the sender
(FR-017), never asserted by us.

The release condition is the other name that carries weight: held tickets wait on 001's
`IssueResolved`, which means **verified in production**. Nothing in this contract releases a ticket
on a merge or a deploy (R-11), and only `resolutionKind` `remediated` or `fixed` with non-empty
verification evidence releases at all (FR-018, C-09).

`SupportAnswerWithheld` and `SupportTicketEscalated` do not overlap, and the boundary is whether a
decision was reached. **`SupportAnswerWithheld` is the answer decision's own negative outcome**: the
eight predicates were evaluated, one failed, and the event carries that predicate and the retrieval
trace. **`SupportTicketEscalated` is the ticket leaving the automated path without a decision** — the
hold ceiling passed, the hold resolved without verification evidence, the category is blocked, or the
reporter's language is outside the declared set. It carries a `reason` from a closed set and no
`failedPredicate`, because in none of those cases was a predicate evaluated. A ticket therefore emits
at most one of the two, and a reader can tell "we decided not to answer" from "we never decided".

## Events this feature publishes

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `SupportReportAccepted` | a report becomes an `Issue` of kind `user_report` | ticketId, channel, deliveryId, language | 003, 011 |
| `SupportReportDuplicate` | repeat delivery on the same channel identifier | ticketId, deliveryId | dashboard |
| `SupportTicketHeld` | linked to an issue under investigation | ticketId, linkedIssueId, heldUntil | dashboard |
| `SupportTicketReleased` | linked issue verified in production | ticketId, linkedIssueId, verificationEvidenceIds | 011 |
| `SupportTicketEscalated` | the ticket leaves the automated path **without a decision** — hold ceiling passed, hold released as `self_resolved`, blocked category, or an unsupported reporter language | ticketId, reason (`hold_expired` · `resolution_without_verification` · `category_blocked` · `language_unsupported`) | dashboard, 002 |
| `SupportAnswerDrafted` | **`AUTO_REPLY`** — the draft, its citations, evidence and rationale | draftId, text, citations, evidenceIds, outcomeRationale, policyVersion | external sender, dashboard |
| `SupportAnswerWithheld` | the answer decision ran and **a predicate failed** — `NEEDS_HUMAN` or `INSUFFICIENT_CONTEXT` | draftId (nullable), outcome, failedPredicate, retrievalTrace | dashboard, 011 |
| `GroundingRejected` | a claim had no candidate span, or a span was rejected | draftId, claimId, ungroundedReason | 011 |
| `CitedDocumentTenantMismatch` | ownership re-verification failed at finalisation | draftId, citationId, documentId | **incident** (FR-015) |
| `AnswerFeedbackRecorded` | a send was reported, or a ticket reopened | draftId, signal, modelId, promptVersionId | 011 |
| `CategoryPromotable` | consecutive clean sends reached the threshold | tenantId, category, counterSnapshot | dashboard (C-07, R-15) |
| `CategoryPromoted` | a human tenant administrator promoted it | category, promotedBy, eligibilitySnapshot | audit, 011 |
| `CategoryEligibilityReset` | a material edit or a reopen reset the counter | category, resetReason | dashboard |

## Events this feature consumes

| Event | From | Effect |
|-------|------|--------|
| `DiagnosisCompleted` | 006 | branches to the answer decision for `user_report` issues |
| `IssueResolved` | 001 | **the only release condition**, and only for `resolutionKind ∈ {remediated, fixed}` with non-empty verification evidence identifiers; `self_resolved` escalates the held tickets instead (FR-018, C-09) |
| `IssueReopened` | 001 | tickets answered from that issue are flagged for human follow-up (FR-019) |
| `IssueDetected` / `IssueRecurred` | 001 | correlates a report with an alert on the same component and window without merging them (US-1 scenario 2) |
| `ChangeVerifiedInProduction` | 008 | reaches this feature as the cause of `IssueResolved`; 009 never consumes a pull request event directly |
| `PolicyDecisionRecorded` | 002 | the `AnswerPolicy` outcome, with its predicate results |
| `KnowledgeDocumentVersionChanged` | 005 | invalidates drafts whose citations pin the old version (R-17) |

## Explicitly not consumed

`PullRequestOpened` and `PullRequestUpdated` (008). A pull request is not a resolution, and a held
ticket that reacted to one would be telling a customer their problem is fixed while the canary is
still running (R-11).

## Delivery guarantees

- At-least-once. Consumers are idempotent by `(eventId, consumer)` (012 FR-028).
- Ordering is guaranteed per issue, not globally.
- A tenant with no external sender configured accumulates `SupportAnswerDrafted` events in the
  outbox. The unconsumed depth is monitored and visible — nothing is discarded (R-20, 001 FR-019).
- A consumer that cannot process an event retries with backoff and lands in a dead-letter queue,
  which is itself observable.
