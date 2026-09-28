import { currentCorrelationId } from '@healer/shared';
import type { DomainEvent } from '@healer/events';
import type { Issue, IssueRelationship } from './issue.js';
import type { IssueEventCause, NewIssueStateChangedEvent } from './state-machine.js';

/**
 * Outbox events this package publishes (001 T013, contracts/events.md). `create`, `transition`
 * (001 T012), `correlate` (001 T039), the staleness sweep (T051) and a human close (T057,
 * `IssueResolved(self_resolved)` from `transition`) each have a real producing operation; the
 * remaining events in the contract (`IssueReopened`, `IssueRecurred`, `IssueMerged`/`Unmerged`,
 * and `IssueResolved`'s verified kinds) have no operation to hang off yet and are
 * wired when the task that builds it lands (T049, 010 and friends) — flagged in
 * QUESTIONS.md rather than guessed at ahead of them.
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

/**
 * How an issue was resolved (contracts/events.md "IssueResolved and its three kinds", C-09). A
 * discriminated union so the two invalid shapes cannot be written: `self_resolved` carrying
 * verification evidence (nobody verified anything), and `remediated`/`fixed` carrying none (an
 * automated resolution means verified in production).
 */
export type IssueResolution =
  | {
      readonly kind: 'self_resolved';
      readonly verifiedAt?: never;
      readonly verificationEvidenceIds?: never;
    }
  | {
      readonly kind: 'remediated' | 'fixed';
      readonly verifiedAt: Date;
      readonly verificationEvidenceIds: readonly [string, ...string[]];
    };

/**
 * The resolution a transition landing on `resolved` with this cause publishes. Only a human close
 * has one in v1 (`self_resolved`): `fixed` is reserved and `remediated` needs 010, and neither has
 * an emitter that could supply the evidence ids. The state machine's `checkResolutionCause`
 * refuses the other causes first; this repeats the rule at the publish site so that widening one
 * without the other fails loudly (and `issue-resolved.test.ts` fails) instead of publishing a
 * `self_resolved` for a resolution a person did not make.
 */
export function resolutionForCause(cause: IssueEventCause): IssueResolution {
  if (cause !== 'human') {
    throw new Error(
      `no verified-resolution emitter exists yet (C-09): cause "${cause}" has no IssueResolved to publish`,
    );
  }
  return { kind: 'self_resolved' };
}

/**
 * `IssueResolved` (001 T054/T057, contracts/events.md) — **the only place it is constructed**
 * (`issue-resolved.test.ts` scans the sources to keep it so). 009 releases a held ticket only on a
 * verified kind with non-empty evidence, so an emitter that built this by hand with the wrong
 * shape would release tickets on a resolution nobody verified (C-09).
 */
export function issueResolvedEvent(
  tenantId: string,
  issueId: string,
  resolution: IssueResolution,
): DomainEvent {
  return {
    name: 'IssueResolved',
    tenantId,
    subjectId: issueId,
    correlationId: requireCorrelationId(),
    payload:
      resolution.kind === 'self_resolved'
        ? { resolutionKind: resolution.kind, verificationEvidenceIds: [] }
        : {
            resolutionKind: resolution.kind,
            verifiedAt: resolution.verifiedAt.toISOString(),
            verificationEvidenceIds: [...resolution.verificationEvidenceIds],
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

/** `IssueMerged` (001 T049, contracts/events.md): on the merged issue's own stream, naming the survivor. */
export function issueMergedEvent(
  tenantId: string,
  issueId: string,
  intoIssueId: string,
  reason: string,
): DomainEvent {
  return {
    name: 'IssueMerged',
    tenantId,
    subjectId: issueId,
    correlationId: requireCorrelationId(),
    payload: { intoIssueId, reason },
  };
}

/** `IssueUnmerged` (001 T050, contracts/events.md): the reversal, naming the issue it was merged into. */
export function issueUnmergedEvent(
  tenantId: string,
  issueId: string,
  intoIssueId: string,
): DomainEvent {
  return {
    name: 'IssueUnmerged',
    tenantId,
    subjectId: issueId,
    correlationId: requireCorrelationId(),
    payload: { intoIssueId },
  };
}

/**
 * `IssueDeleted` (001 T053, contracts/events.md): the tombstone id and nothing else. `subjectId` is
 * the deleted issue's id — an identifier the tombstone also holds, not content.
 */
export function issueDeletedEvent(
  tenantId: string,
  issueId: string,
  tombstoneId: string,
): DomainEvent {
  return {
    name: 'IssueDeleted',
    tenantId,
    subjectId: issueId,
    correlationId: requireCorrelationId(),
    payload: { tombstoneId },
  };
}
