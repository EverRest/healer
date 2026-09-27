import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  drain,
  PrismaOutboxStore,
  toOutboxRecord,
  type DomainEvent,
  type EventBroker,
} from '@healer/events';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `PrismaOutboxStore` (001 T013, review fixes): the claim query must be safe for concurrent
 * drain workers (`FOR UPDATE SKIP LOCKED`, never a plain unlocked read), and a permanently
 * failing event must not block every event behind it (ordered by `attempts` first).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));
const TENANT_ID = '00000000-0000-0000-8000-0000000000a9';

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function event(name: string): DomainEvent {
  return {
    name,
    tenantId: TENANT_ID,
    subjectId: randomUUID(),
    correlationId: randomUUID(),
    payload: {},
  };
}

describe('PrismaOutboxStore (001 T013, review fixes)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let store: PrismaOutboxStore;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    store = new PrismaOutboxStore(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('a permanently failing event does not block a fresh event behind it (review finding)', async () => {
    const poisoned = toOutboxRecord(event('Poisoned'));
    const fresh1 = toOutboxRecord(event('Fresh1'));
    await prisma.outbox.create({ data: { ...poisoned, payload: poisoned.payload as object } });

    const poisonBroker: EventBroker = {
      publish: (record) =>
        record.name === 'Poisoned' ? Promise.reject(new Error('always fails')) : Promise.resolve(),
    };

    // Fail the poisoned event a few times first, as if earlier drains already retried it.
    for (let i = 0; i < 3; i++) await drain(store, poisonBroker, { batchSize: 1 });

    // Now a fresh event arrives, with lower `attempts` than the poisoned one.
    await prisma.outbox.create({ data: { ...fresh1, payload: fresh1.payload as object } });
    const result = await drain(store, poisonBroker, { batchSize: 1 });

    // With attempts-first ordering the fresh event is claimed before the poisoned one, even
    // though the poisoned one is older — the old occurred_at-only ordering would have retried
    // the poisoned event yet again and starved the fresh one.
    expect(result.published).toBe(1);
    const unpublishedFresh = await query(
      pg,
      `select published_at from "events"."outbox" where id = '${fresh1.id}'`,
    );
    expect(unpublishedFresh).not.toBe('');
  });

  it('two concurrent claims never return the same row (FOR UPDATE SKIP LOCKED, review finding)', async () => {
    await query(pg, `delete from "events"."outbox"`);
    for (let i = 0; i < 10; i++) {
      const record = toOutboxRecord(event(`Batch${i}`));
      await prisma.outbox.create({ data: { ...record, payload: record.payload as object } });
    }

    const [batchA, batchB] = await Promise.all([
      store.claimUnpublished(5),
      store.claimUnpublished(5),
    ]);
    const idsA = new Set(batchA.map((r) => r.id));
    const idsB = new Set(batchB.map((r) => r.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));
    expect(overlap).toEqual([]);
    expect(idsA.size + idsB.size).toBe(10);
  });

  it('recordFailure clears the claim so the row is immediately reclaimable, deprioritised by attempts', async () => {
    await query(pg, `delete from "events"."outbox"`);
    const record = toOutboxRecord(event('Retryable'));
    await prisma.outbox.create({ data: { ...record, payload: record.payload as object } });

    const [claimed] = await store.claimUnpublished(1);
    await store.recordFailure(claimed!.id, 'boom');

    const reclaimed = await store.claimUnpublished(1);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.attempts).toBe(1);
  });
});
