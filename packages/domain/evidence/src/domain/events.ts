import { currentCorrelationId } from '@healer/shared';
import type { DomainEvent } from '@healer/events';
import type { Evidence } from './types.js';

/**
 * Outbox events this package publishes (001 T013, contracts/events.md) — `EvidenceRecorded` and
 * `EvidenceDetached`, the two events with a real producing operation today (`record`/`detach`,
 * 001 T006). `subjectId` is the owning issue, not the evidence itself: delivery ordering is
 * guaranteed per issue, not globally (events.md), so every event about an issue's evidence needs
 * the same subject as the issue's own events.
 */
function requireCorrelationId(): string {
  const id = currentCorrelationId();
  if (id === undefined) {
    throw new Error('cannot publish a domain event outside a correlated scope (withCorrelation)');
  }
  return id;
}

export function evidenceRecordedEvent(evidence: Evidence): DomainEvent {
  return {
    name: 'EvidenceRecorded',
    tenantId: evidence.tenantId,
    subjectId: evidence.issueId,
    correlationId: requireCorrelationId(),
    payload: {
      evidenceId: evidence.id,
      type: evidence.type,
      producedByStep: evidence.producedByStep,
    },
  };
}

export function evidenceDetachedEvent(evidence: Evidence): DomainEvent {
  return {
    name: 'EvidenceDetached',
    tenantId: evidence.tenantId,
    subjectId: evidence.issueId,
    correlationId: requireCorrelationId(),
    payload: {
      evidenceId: evidence.id,
      sourceLabel: evidence.sourceLabel,
    },
  };
}
