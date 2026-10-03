import { describe, expect, it } from 'vitest';
import { withCorrelation } from '@healer/shared';
import { enqueue, type OutboxRecord, type OutboxTransaction } from '@healer/events';
import {
  boundaryPayloadRejectedEvent,
  contextCollectedEvent,
  contextDegradedEvent,
  contextItemWithheldEvent,
  contextPassDispatchedEvent,
} from './events.js';

const TENANT_ID = '0193a1f0-0000-7000-8000-0000000000f1';

class FakeTransaction implements OutboxTransaction {
  staged: OutboxRecord[] = [];
  async insertOutbox(record: OutboxRecord): Promise<void> {
    this.staged.push(record);
  }
}

describe('context outbox event builders (003 T014, contracts/collection-plan.md)', () => {
  it('every builder requires an active correlation scope', () => {
    expect(() =>
      contextPassDispatchedEvent(TENANT_ID, { passId: 'p', planDigest: 'd', collectorKeys: [] }),
    ).toThrow(/correlated scope/);
  });

  it('builds all five events with their contract names and payloads, and each reaches the outbox', async () => {
    const tx = new FakeTransaction();
    await withCorrelation('corr-1', async () => {
      const events = [
        contextCollectedEvent(TENANT_ID, {
          snapshotId: 's1',
          issueId: 'i1',
          version: 1,
          completeness: { expected: ['loki_logs'] },
          budgetState: 'within',
        }),
        contextPassDispatchedEvent(TENANT_ID, {
          passId: 'p1',
          planDigest: 'sha256:x',
          collectorKeys: ['loki_logs', 'otel_traces'],
        }),
        contextDegradedEvent(TENANT_ID, {
          passId: 'p1',
          collectorKey: 'prometheus_metrics',
          status: 'unavailable',
          reasonCode: 'source_unreachable',
          gapEvidenceId: 'g1',
        }),
        contextItemWithheldEvent(TENANT_ID, {
          passId: 'p1',
          localRef: 'r1',
          itemClass: 'error_signature',
          reasonCode: 'redaction_withheld',
        }),
        boundaryPayloadRejectedEvent(TENANT_ID, {
          rejectionId: 'b1',
          runnerId: 'r1',
          contractVersion: 1,
          schemaErrorPaths: ['items.0#unrecognized_keys'],
        }),
      ];
      expect(events.map((e) => e.name)).toEqual([
        'ContextCollected',
        'ContextPassDispatched',
        'ContextDegraded',
        'ContextItemWithheld',
        'BoundaryPayloadRejected',
      ]);
      for (const e of events) await enqueue(tx, e);
    });
    expect(tx.staged).toHaveLength(5);
    const degraded = tx.staged[2]!;
    expect(degraded.payload).toMatchObject({
      gapEvidenceId: 'g1',
      reasonCode: 'source_unreachable',
    });
    expect(degraded.subjectId).toBe('p1');
  });
});
