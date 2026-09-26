# Contract: reproduction events

Published through the transactional outbox (012 FR-031), so no consumer observes an attempt that was
rolled back. Every event carries `tenantId`, `issueId`, `correlationId`, `occurredAt` and a schema
version.

## Naming discipline

The rule 001 sets applies: past tense describes a **fact**. `ReproductionCompleted` fires for all
three results including `PASS` and `INCONCLUSIVE` — "we could not reproduce it" is a completed
reproduction, not a failure, and publishing it as an error would push the system toward claiming a
`FAIL`. There is no `ReproductionFailed` event: `FAIL` is the success condition here
(`contracts/ladder.md`), and a name that inverted that would be read backwards by every consumer.

Nothing here publishes eligibility. `change_eligibility` is a view (R-16); an event carrying it would
be a second copy that can disagree with the first. Consumers treat these events as triggers and
re-read the view.

## Events this feature publishes

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `ReproductionCompleted` | a `reproduction_attempt` reaches a terminal result | `attemptId`, `diagnosisId`, `result` (`PASS` · `FAIL` · `INCONCLUSIVE`), `inconclusiveReason`, `reproducingRung`, `observedRuns`, `reproducedRuns`, `intermittent`, `observedRate`, `maxRung`, `budgetConsumed` | 008, 002, 011, dashboard |
| `CiResultsReceived` | a `ci_delegation` callback is accepted and its results are ingested | `delegationId`, `executionRunId`, `attemptId`, `suiteScope`, `externalRunId`, `outcome`, `resultCounts`, `receivedCount` | 008, 011, dashboard |
| `ReproductionEscalatedToHuman` | `INCONCLUSIVE`, or a delegation deadline passed | `attemptId`, `reason`, `handoffRef` | 009, 011, dashboard |
| `SeparateDefectFound` | a run reproduced *a* failure that is not *the* failure | `attemptId`, `observedSignature`, `issueSignature` | 001, 011, dashboard |
| `FixtureBlockedByScan` | a candidate fixture matched a secret or personal-data pattern | `executionRunId`, `constructionMode`, `findingRef` | 002, 011, dashboard |

`ReproductionCompleted` with `result = FAIL` is what 008's fix loop listens for; the loop still reads
`change_eligibility` **and** 006's `fix_eligibility` itself before it opens (008 FR-009, C-08) — the
event is a trigger, never the authority.

`CiResultsReceived` is the event 008 resolves `awaiting_ci` on (008 R-24, FR-020). The results
themselves are `test_result` evidence records correlated to the requesting execution (FR-023); the
event carries counts and identifiers, never test output.

## Events this feature consumes

| Event | From | Effect |
|-------|------|--------|
| `ReproductionDirectiveIssued` | 006 | the climb is dispatched for that directive, starting at the cheapest rung and never above `maxRung` (006 R-13) |
| `DiagnosisCompleted` | 006 | `ROOT_CAUSE_IDENTIFIED` is the only outcome a directive accompanies; any other outcome starts nothing |
| `BudgetThresholdCrossed` | 002 | the next rung is refused (002 FR-011); the attempt ends `INCONCLUSIVE` / `budget_exhausted` with the ladder preserved |
| `GraphVersionPublished` | 004 | no effect on a finished attempt — a result is about the commit it ran on |

## Delivery guarantees

- At-least-once. Consumers are idempotent by `(eventId, consumer)` (012 FR-028).
- Ordering is guaranteed per issue: `ReproductionCompleted` for an attempt always follows every
  `rung_attempt` row it summarises, because the attempt row cannot reach a terminal result first.
- A duplicate `CiResultsReceived` delivery changes nothing but is counted (`receivedCount`, FR-022).
- A consumer that cannot process an event retries with backoff and lands in a dead-letter queue,
  which is itself observable.
