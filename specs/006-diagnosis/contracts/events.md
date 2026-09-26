# Contract: diagnosis events

Published through the transactional outbox (012 FR-031), so no consumer observes a diagnosis that
was rolled back. Every event carries `tenantId`, `issueId`, `correlationId`, `occurredAt` and a
schema version.

## Naming discipline

The same rule 001 applies: past tense describes a **fact**. Two names here carry weight.

`IssueClassified` fires for every verdict including `UNDETERMINED`, because "the classifier ran and
could not tell" is a fact that downstream must act on, and a silent non-event is indistinguishable
from a classifier that never ran. `DiagnosisCompleted` fires for all four outcomes including
`UNKNOWN` — an honest "I don't know" is a completed diagnosis, not a failure, and publishing it as
an error would push the system toward answering.

Nothing here publishes eligibility. Eligibility is a view (research R-03); an event carrying it
would be a second copy that can disagree with the first.

## Events this feature publishes

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `IssueClassified` | a classification row is written | `classificationId`, `taxonomyClass`, `verdict`, `decidedBy`, `rulesetVersion` | 002, 007, 010, 011, dashboard |
| `ClassificationOverridden` | a human writes a new classification | `classificationId`, `overrideOfId`, `actorRef`, `reason` | 002, 011, audit |
| `DiagnosisCompleted` | a diagnosis version is persisted | `diagnosisId`, `attemptNo`, `outcome`, `terminationReason`, `expectationState` | 001, 002, 007, 008, 009, 011 |
| `ReproductionDirectiveIssued` | a directive is written alongside a `ROOT_CAUSE_IDENTIFIED` outcome | `directiveId`, `suggestedRung`, `maxRung` | 007 |
| `DiagnosisEscalatedToHuman` | second rejection, budget exhaustion, or `UNKNOWN` / `INSUFFICIENT_CONTEXT` | `reason`, `attemptCount`, `handoffRef` | 009, 011, dashboard |
| `DiagnosisFoundKnowledgeDrift` | code and an adopted expectation disagree, code behaving as intended by users | `expectationId`, `expectationVersionId`, `evidenceIds` | 005 (FR-016), 001 |
| `PrecedentMarkedStale` | a precedent's referenced code is found absent | `referencedIssueId`, `liveness` | 011, dashboard |

`DiagnosisCompleted` with `outcome = NOT_A_CODE_PROBLEM` is what 010 listens for to propose a
reversible remediation (010 FR-018 requires an established cause first). 008 listens for
`outcome = ROOT_CAUSE_IDENTIFIED`, and still re-checks eligibility through the view — the event is a
trigger, never the authority.

## Events this feature consumes

| Event | From | Effect |
|-------|------|--------|
| `ContextCollected` | 003 | classification is dispatched on the snapshot; collection gaps are available as `collection_gap` evidence (research R-07) |
| `ContextRecollected` | 003 | a follow-up pass requested by diagnosis (003 FR-005) resolves; the run resumes from its persisted state |
| `VerificationVerdictRecorded` | 008 | a verdict of `REJECT_DIAGNOSIS` (008 FR-017) triggers exactly one re-diagnosis; a second escalates |
| `GraphVersionPublished` | 004 | no effect on completed diagnoses — each run pins its graph version (004 FR-014) and is never re-resolved |
| `ExpectationAdopted` | 005 | no retroactive effect: `pre_existing` was frozen at write time (research R-05) |
| `BudgetThresholdCrossed` | 002 | the next model step is refused (002 FR-011); a partial diagnosis is persisted |

The last two rows are deliberate non-effects. Both describe a later fact that would, if applied
backwards, change what a past run was permitted to conclude — which is the shape of a circular
verification (ADR 0002).

## Delivery guarantees

- At-least-once. Consumers are idempotent by `(eventId, consumer)`.
- Ordering is guaranteed per issue: `IssueClassified` always precedes `DiagnosisCompleted` for the
  same issue, because the diagnosis row cannot exist without the classification row.
- A consumer that cannot process an event retries with backoff and lands in a dead-letter queue,
  which is itself observable.
