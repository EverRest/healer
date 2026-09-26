# Contract: domain events

Published through the transactional outbox (001 FR-014, 012 FR-031). Every event carries `tenantId`,
`issueId`, `correlationId`, `occurredAt` and a schema version.

## Naming discipline

The rule from 001 applies with more force here. **This feature's terminal state is `PR_OPENED`**
(`contracts/fix-loop.md`): at L2 Healer neither merges nor deploys (D-12), so it never observes the
production behaviour of its own change and publishes no production-verification event in v1 (R-25,
C-09). The name `ChangeVerifiedInProduction` is **reserved** — see the section below — and has no
emitter here.

`PullRequestOpened` is a fact about a request, not about a merge. **There is no `PullRequestMerged`
event published by this feature** — Healer does not merge (FR-024, D-12). A merge observed in the
repository arrives as an inbound fact on `POST /callbacks/merge-events`, attributed to the human who
performed it (R-26).

## Events this feature publishes

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `ImpactAnalysed` | change graph and classification produced | analysisId, classification, touchPredicates, analysedCommit, coverageGaps | 002, 011, dashboard |
| `ChangePlanSubmitted` | plan version submitted for evaluation | planId, version, fileCounts by role, classification, anchorResolutionId | 002 |
| `ChangePlanRejected` | policy denied, or the plan was invalidated | planId, version, reason, policyDecisionId | dashboard, 011 |
| `FixPathClosed` | anchor verdict is not `ANCHORED` | anchorVerdict, issueFirstSeenAt, expectationId (nullable) | 001, 005, dashboard |
| `RedVerified` | signature-matched failure on the base commit | attemptId, regressionTestId, executionId, baseCommit, signatureRulesetVersion | 011 |
| `GreenVerified` | regression test passes and the reproduction stops | attemptId, regressionTestId, executionId, repeatCount | 011 |
| `MaskingCandidateDetected` | deterministic diff inspection flagged a pattern | attemptId, patterns, disposition | 002, dashboard, 011 |
| `TestQuarantined` | a test disagreed with itself across repeats | repositoryId, testIdentifier, commitSha, observedOutcomes | 011, dashboard |
| `VerificationVerdictRecorded` | verifier returned | attemptId, verdict, anchorsUsed, independenceRankAchieved | 006, 002, 011 |
| `FixAttemptClosed` | attempt ended, successful or not | attemptId, attemptNumber, verdict, rejectionReason, approachFingerprint, cost | 011 |
| `PullRequestOpened` | request created at the provider | pullRequestRecordId, externalId, repositoryId, targetBranch, awaitingCi | 009, dashboard |
| `PullRequestUpdated` | a later attempt updated the existing request | pullRequestRecordId, attemptIds, changeFingerprint | dashboard |
| `ChangeHandedToHuman` | attempt cap, budget, a second `REJECT_DIAGNOSIS`, or `NO_RECIPE` (FR-011a) | reason, attemptIds, whatWasRuledOut | 002, dashboard |
| `MergeFactReceived` | an inbound merge fact arrived on `/callbacks/merge-events` | pullRequestRecordId, externalId, outcome (`merged` · `closed_unmerged` · `force_pushed_over`), actorRef, observedAt | 001, 011, dashboard |

## Reserved, post-v1, no emitter

**`ChangeVerifiedInProduction` is not emitted in v1** (R-25, C-09). It would mean verified *in
production* — not GREEN in the sandbox, not merged, not deployed — and at L2 this feature's terminal
state is `PR_OPENED`, so nothing here can observe that. The name is reserved for the
deployment-verification capability L4 requires: no task publishes it, and no v1 consumer may wait on
it. `IssueResolved` in v1 comes from 010's verified remediation or from a human closing the issue
(C-09).

A feature that published "verified in production" while being structurally unable to watch production
would be the most dangerous kind of wrong: 009 releases held tickets on exactly that class of event.
011 therefore reports its production-verification and 30-day revert metrics as **unavailable** for
changes from this feature, not as zero (011 FR-019).

## Events this feature consumes

| Event | From | Effect |
|-------|------|--------|
| `DiagnosisCompleted` | 006 | with `ROOT_CAUSE_IDENTIFIED`, starts anchor resolution — the diagnosis does **not** supply the anchor (R-04) |
| `ReproductionCompleted` | 007 | only `FAIL` opens the fix path (FR-009, 007 FR-001) |
| `PolicyDecisionRecorded` | 002 | plan approved, denied, or awaiting approval |
| `ApprovalGranted` / `ApprovalExpired` | 002 | resumes or stops the workflow (002 FR-016) |
| `ExpectationRevoked` | 005 | an in-flight attempt whose anchor was revoked stops; a closed attempt is flagged (005 FR-013) |
| `CiResultsReceived` | 007 | resolves `awaiting_ci`; results ingested as evidence (007 FR-023, 007 `contracts/events.md`) |
| `IssueReopened` | 001 | an issue reopened after a pull request was merged flags the attempt; in v1 there is no production-verification claim to invalidate (R-25) |

## Delivery guarantees

- At-least-once. Consumers are idempotent by `(eventId, consumer)` (012 FR-028).
- Ordering is guaranteed per issue, not globally.
- `MergeFactReceived` is emitted once per delivered merge fact; a duplicate delivery changes nothing
  (R-26). Absence means **unknown** — a tenant may not have configured the webhook — never "unmerged".
- A consumer that cannot process an event retries with backoff and lands in a dead-letter queue,
  which is itself observable — a silently stuck consumer looks exactly like a quiet system.
