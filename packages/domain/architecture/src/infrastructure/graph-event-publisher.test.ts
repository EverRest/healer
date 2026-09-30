import { withCorrelation } from '@healer/shared';
import type { OutboxRecord, OutboxTransaction } from '@healer/events';
import { describe, expect, it } from 'vitest';
import {
  publishDiscoveryDraftProposed,
  publishGraphDriftDetected,
  publishGraphElementStale,
  publishGraphVersionPublished,
} from './graph-event-publisher.js';

/**
 * A transaction that can be rolled back — the same fake `packages/events/src/outbox.test.ts` uses
 * to prove `enqueue` writes into the caller's transaction rather than publishing directly. Proving
 * these four publishers go through it, not around it, is the point of this file (004 T014).
 */
class FakeTransaction implements OutboxTransaction {
  staged: OutboxRecord[] = [];
  committed: OutboxRecord[] = [];

  async insertOutbox(record: OutboxRecord): Promise<void> {
    this.staged.push(record);
  }
  commit(): void {
    this.committed.push(...this.staged);
    this.staged = [];
  }
  rollback(): void {
    this.staged = [];
  }
}

describe('graph event publishers write through the transactional outbox (004 T014, 012 FR-031)', () => {
  it('publishDiscoveryDraftProposed stages a record and nothing more until commit', async () => {
    const tx = new FakeTransaction();
    const record = await withCorrelation('corr-1', () =>
      publishDiscoveryDraftProposed(tx, 'tenant-1', {
        draftId: 'draft-1',
        runId: 'run-1',
        baseVersion: 0,
        countsByOp: { add_node: 1, add_edge: 0, modify_attributes: 0, mark_removed: 0 },
      }),
    );
    expect(tx.committed).toEqual([]);
    tx.commit();
    expect(tx.committed).toEqual([record]);
    expect(record.name).toBe('DiscoveryDraftProposed');
  });

  it('is not observable when the transaction rolls back', async () => {
    const tx = new FakeTransaction();
    await withCorrelation('corr-2', () =>
      publishGraphVersionPublished(tx, 'tenant-1', {
        versionId: 'version-1',
        version: 1,
        mintedBy: 'confirmation',
        changedElementCounts: { nodes: 1, edges: 0 },
      }),
    );
    tx.rollback();
    expect(tx.committed).toEqual([]);
  });

  it('publishGraphDriftDetected stages the drift event through the outbox', async () => {
    const tx = new FakeTransaction();
    const record = await withCorrelation('corr-3', () =>
      publishGraphDriftDetected(tx, 'tenant-1', {
        findingId: 'finding-1',
        kind: 'observed_edge_absent',
        issueId: 'issue-1',
        graphVersion: 4,
      }),
    );
    tx.commit();
    expect(tx.committed).toEqual([record]);
    expect(record.payload).toMatchObject({ findingId: 'finding-1', graphVersion: 4 });
  });

  it('publishGraphElementStale stages the staleness event through the outbox', async () => {
    const tx = new FakeTransaction();
    const record = await withCorrelation('corr-4', () =>
      publishGraphElementStale(tx, 'tenant-1', {
        nodeId: 'node-1',
        lastObservedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    tx.commit();
    expect(tx.committed).toEqual([record]);
    expect(record.subjectId).toBe('node-1');
  });
});
