import { beforeEach, describe, expect, it } from 'vitest';
import {
  type DomainEvent,
  type EventBroker,
  type OutboxRecord,
  type OutboxStore,
  type OutboxTransaction,
  OutboxRowGoneError,
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

    expect(await drain(store, broker)).toEqual({ published: 1, failed: 0, vanished: 0 });
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

    expect(await drain(store, broker)).toEqual({ published: 0, failed: 1, vanished: 0 });
    const [remaining] = await store.claimUnpublished(10);
    expect(remaining?.attempts).toBe(1);
    expect(remaining?.lastError).toBe('broker unreachable');
  });

  describe('a claimed row that was deleted before it could be marked (001 T053)', () => {
    /** A store whose rows can vanish between the claim and the mark, as a tenant deletion does. */
    class VanishingStore extends FakeStore {
      gone = new Set<string>();
      override async markPublished(id: string, at: Date): Promise<void> {
        if (this.gone.has(id)) throw new OutboxRowGoneError(id);
        return super.markPublished(id, at);
      }
      override async recordFailure(id: string, error: string): Promise<void> {
        if (this.gone.has(id)) throw new OutboxRowGoneError(id);
        return super.recordFailure(id, error);
      }
    }

    it('counts a row that vanished after publishing and carries on with the rest of the batch', async () => {
      const records = [
        await enqueue(tx, { ...event, name: 'A' }),
        await enqueue(tx, { ...event, name: 'B' }),
        await enqueue(tx, { ...event, name: 'C' }),
      ];
      const store = new VanishingStore(records);
      store.gone.add(records[0]!.id);

      const result = await drain(store, { publish: async () => undefined });

      expect(result).toEqual({ published: 2, failed: 0, vanished: 1 });
      expect(store.records.filter((r) => r.publishedAt).map((r) => r.name)).toEqual(['B', 'C']);
    });

    it('counts a row that vanished while its broker failure was being recorded, and carries on', async () => {
      const records = [
        await enqueue(tx, { ...event, name: 'A' }),
        await enqueue(tx, { ...event, name: 'B' }),
      ];
      const store = new VanishingStore(records);
      store.gone.add(records[0]!.id);
      const broker: EventBroker = {
        publish: async (r) => {
          if (r.name === 'A') throw new Error('broker unreachable');
        },
      };

      expect(await drain(store, broker)).toEqual({ published: 1, failed: 0, vanished: 1 });
    });

    it('still lets any other store error out of the batch — only "row gone" is forgiven', async () => {
      const record = await enqueue(tx, event);
      const store = new FakeStore([record]);
      store.markPublished = async () => {
        throw new Error('database down');
      };
      store.recordFailure = async () => {
        throw new Error('database down');
      };

      await expect(drain(store, { publish: async () => undefined })).rejects.toThrow(
        'database down',
      );
    });
  });

  it('cannot be written outside a transaction — the store has no insert', () => {
    const store = new FakeStore([]);
    expect('insertOutbox' in store).toBe(false);
  });
});
