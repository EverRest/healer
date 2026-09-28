import { currentCorrelationId } from '@healer/shared';
import type { DomainEvent } from '@healer/events';
import type { Issue, IssueRelationship } from './issue.js';
import type { NewIssueStateChangedEvent } from './state-machine.js';

/**
 * Outbox events this package publishes (001 T013, contracts/events.md). `create`, `transition`
 * (001 T012) and `correlate` (001 T039) each have a real producing operation; the remaining
 * events in the contract (`IssueReopened`, `IssueRecurred`, `IssueMerged`/`Unmerged`,
 * `IssueStale`, `IssueResolved`, `IssueDeleted`) have no operation to hang off yet and are wired
 * when the task that builds it lands (T049, T051, T053 and friends) — flagged in QUESTIONS.md
 * rather than guessed at ahead of them.
 */

/**
 * Requires an active correlation scope (`@healer/shared`'s tracing module). Its own doc comment
 * warns against inventing one here: "would produce a second trace for the same work, which reads
 * as two investigations" — so a missing scope is a caller error, not something to paper over.
 */
function requireCorrelationId(): string {
  const id = currentCorrelationId();
  if (id === undefined) {
    throw new Error('cannot publish a domain event outside a correlated scope (withCorrelation)');
  }
  return id;
}

export function issueDetectedEvent(issue: Issue): DomainEvent {
  return {
    name: 'IssueDetected',
    tenantId: issue.tenantId,
    subjectId: issue.id,
    correlationId: requireCorrelationId(),
    payload: {
      kind: issue.kind,
      component: issue.componentId,
      severity: issue.severity,
      fingerprint: issue.fingerprint,
    },
  };
}

/** contracts/events.md: "deterministic correlation linked two issues" — payload is exactly the
 * two fields that let a consumer explain the link without a second lookup (FR-020). */
export function issueRelatedEvent(tenantId: string, relationship: IssueRelationship): DomainEvent {
  return {
    name: 'IssueRelated',
    tenantId,
    subjectId: relationship.issueId,
    correlationId: requireCorrelationId(),
    payload: {
      otherIssueId: relationship.otherIssueId,
      rule: relationship.rule,
    },
  };
}

export function issueStateChangedEvent(
  tenantId: string,
  event: NewIssueStateChangedEvent,
): DomainEvent {
  return {
    name: 'IssueStateChanged',
    tenantId,
    subjectId: event.issueId,
    correlationId: requireCorrelationId(),
    payload: {
      fromState: event.fromState,
      toState: event.toState,
      cause: event.cause,
      actorRef: event.actorRef,
    },
  };
}

/** `IssueStale` (001 T051, contracts/events.md): surfaced to the dashboard, never a resolution. */
export function issueStaleEvent(
  tenantId: string,
  issueId: string,
  lastProgressAt: Date,
): DomainEvent {
  return {
    name: 'IssueStale',
    tenantId,
    subjectId: issueId,
    correlationId: requireCorrelationId(),
    payload: { lastProgressAt: lastProgressAt.toISOString() },
  };
}
