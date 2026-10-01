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
    // `subjectId` falls back to the evidence's own id for the two discovery types, which carry no
    // issue (004 Phase 3). Moot in practice: discovery writes `graph_fact`/`collection_gap` rows
    // directly through its own transaction (see packages/domain/architecture/src/infrastructure/),
    // never through `record()`, so this fallback exists only so the type stays total.
    subjectId: evidence.issueId ?? evidence.id,
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
    // See evidenceRecordedEvent's fallback above — same reasoning, same moot-in-practice note.
    subjectId: evidence.issueId ?? evidence.id,
    correlationId: requireCorrelationId(),
    payload: {
      evidenceId: evidence.id,
      sourceLabel: evidence.sourceLabel,
    },
  };
}
