import { withCorrelation } from '@healer/shared';
import { describe, expect, it } from 'vitest';
import { evidenceDetachedEvent, evidenceRecordedEvent } from './events.js';
import type { Evidence } from './types.js';

const EVIDENCE: Evidence = {
  id: 'evidence-1',
  tenantId: 'tenant-1',
  issueId: 'issue-1',
  type: 'error_signature',
  sourceSystem: 'loki',
  sourceRef: 'ref1',
  sourceLabel: 'from logs',
  excerpt: null,
  excerptTruncated: false,
  payload: {},
  producedByStep: 'collector',
  refState: 'linked',
  observedAt: new Date('2026-01-01T00:00:00Z'),
  receivedAt: new Date('2026-01-01T00:00:00Z'),
  expiresAt: new Date('2026-02-01T00:00:00Z'),
};

describe('evidenceRecordedEvent / evidenceDetachedEvent (001 T013, contracts/events.md)', () => {
  it('evidenceRecordedEvent is subject to the owning issue, not the evidence itself', () => {
    const event = withCorrelation('corr-1', () => evidenceRecordedEvent(EVIDENCE));
    expect(event).toMatchObject({
      name: 'EvidenceRecorded',
      tenantId: 'tenant-1',
      subjectId: 'issue-1',
      correlationId: 'corr-1',
      payload: { evidenceId: 'evidence-1', type: 'error_signature', producedByStep: 'collector' },
    });
  });

  it('evidenceDetachedEvent carries the key payload the contract names', () => {
    const event = withCorrelation('corr-2', () =>
      evidenceDetachedEvent({ ...EVIDENCE, refState: 'detached' }),
    );
    expect(event).toMatchObject({
      name: 'EvidenceDetached',
      subjectId: 'issue-1',
      payload: { evidenceId: 'evidence-1', sourceLabel: 'from logs' },
    });
  });

  it('refuses to build an event outside a correlated scope — inventing one would fake a trace', () => {
    expect(() => evidenceRecordedEvent(EVIDENCE)).toThrow(/correlated scope/);
    expect(() => evidenceDetachedEvent(EVIDENCE)).toThrow(/correlated scope/);
  });
});
