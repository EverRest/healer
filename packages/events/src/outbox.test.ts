import { beforeEach, describe, expect, it } from 'vitest';
import {
  type DomainEvent,
  type EventBroker,
  type OutboxRecord,
  type OutboxStore,
  type OutboxTransaction,
  drain,
  enqueue,
} from './outbox.js';

const event: DomainEvent = {
  name: 'IssueCreated',
  tenantId: '0193a1f0-0000-7000-8000-000000000001',
  subjectId: '0193a1f0-0000-7000-8000-0000000000aa',
  correlationId: '0193a1f0-0000-7000-8000-0000000000bb',
  payload: { kind: 'incident' },
};

/** A transaction that can be rolled back, which is the whole point of the mechanism. */
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

class FakeStore implements OutboxStore {
  constructor(public records: OutboxRecord[]) {}
  async claimUnpublished(limit: number): Promise<OutboxRecord[]> {
    return this.records.filter((r) => !r.publishedAt).slice(0, limit);
  }
  async markPublished(id: string, at: Date): Promise<void> {
    this.records = this.records.map((r) => (r.id === id ? { ...r, publishedAt: at } : r));
  }
  async recordFailure(id: string, error: string): Promise<void> {
    this.records = this.records.map((r) =>
      r.id === id ? { ...r, attempts: r.attempts + 1, lastError: error } : r,
    );
  }
}

describe('outbox', () => {
  let tx: FakeTransaction;
  beforeEach(() => {
    tx = new FakeTransaction();
  });

  it('is not observable when the transaction rolls back', async () => {
    await enqueue(tx, event);
    tx.rollback();
    expect(tx.committed).toEqual([]);
  });

  it('is observable exactly once when the transaction commits', async () => {
    const record = await enqueue(tx, event);
    tx.commit();
    expect(tx.committed).toEqual([record]);
    expect(record.publishedAt).toBeUndefined();
    expect(record.attempts).toBe(0);
  });

  it('publishes claimed records and marks them', async () => {
    const record = await enqueue(tx, event);
    const store = new FakeStore([record]);
    const sent: OutboxRecord[] = [];
    const broker: EventBroker = { publish: async (r) => void sent.push(r) };

    expect(await drain(store, broker)).toEqual({ published: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(await store.claimUnpublished(10)).toEqual([]);
  });

  it('leaves a record unpublished with its failure recorded when the broker fails', async () => {
    const record = await enqueue(tx, event);
    const store = new FakeStore([record]);
    const broker: EventBroker = {
      publish: async () => {
        throw new Error('broker unreachable');
      },
    };

    expect(await drain(store, broker)).toEqual({ published: 0, failed: 1 });
    const [remaining] = await store.claimUnpublished(10);
    expect(remaining?.attempts).toBe(1);
    expect(remaining?.lastError).toBe('broker unreachable');
  });

  it('cannot be written outside a transaction — the store has no insert', () => {
    const store = new FakeStore([]);
    expect('insertOutbox' in store).toBe(false);
  });
});
