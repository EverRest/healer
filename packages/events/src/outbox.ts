import { randomUUID } from 'node:crypto';

/**
 * Transactional outbox (012 FR-031, consumed by 001 FR-014).
 *
 * The property: an event is written **in the same transaction as the state change it
 * describes**, so a rolled-back transition is never observed downstream, and a committed
 * one is never lost. Publishing to the broker happens afterwards, from the table.
 *
 * "Publish after commit" from application code is the alternative, and it fails in one
 * direction silently: the transaction commits, the process dies, nobody ever hears.
 */
export interface DomainEvent {
  readonly name: string;
  readonly tenantId: string;
  /** The aggregate this is about — an issue, a run, a tenant. */
  readonly subjectId: string;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxRecord extends DomainEvent {
  readonly id: string;
  readonly occurredAt: Date;
  readonly publishedAt?: Date;
  readonly attempts: number;
  readonly lastError?: string;
}

/**
 * The transaction handle, as the persistence layer provides it. Narrow on purpose: an
 * outbox that can open its own transaction is an outbox that can be used outside one.
 */
export interface OutboxTransaction {
  insertOutbox(record: OutboxRecord): Promise<void>;
}

export interface OutboxStore {
  /** Claims a batch of unpublished records for this worker. */
  claimUnpublished(limit: number): Promise<OutboxRecord[]>;
  markPublished(id: string, at: Date): Promise<void>;
  recordFailure(id: string, error: string): Promise<void>;
}

export interface EventBroker {
  publish(record: OutboxRecord): Promise<void>;
}

export function toOutboxRecord(event: DomainEvent, now: Date = new Date()): OutboxRecord {
  return { ...event, id: randomUUID(), occurredAt: now, attempts: 0 };
}

/**
 * Enqueues an event inside a caller-owned transaction. Takes the transaction rather than
 * a store: there is no overload that writes outside one.
 */
export async function enqueue(
  tx: OutboxTransaction,
  event: DomainEvent,
  now: Date = new Date(),
): Promise<OutboxRecord> {
  const record = toOutboxRecord(event, now);
  await tx.insertOutbox(record);
  return record;
}

/**
 * A store throws this from `markPublished` / `recordFailure` when the row is no longer there — it was
 * deleted after this worker claimed it (tenant deletion of an issue, 001 T053). Nothing is wrong with
 * the rest of the batch, so `drain` counts it and moves on.
 */
export class OutboxRowGoneError extends Error {
  constructor(readonly recordId: string) {
    super(`outbox record ${recordId} no longer exists`);
    this.name = 'OutboxRowGoneError';
  }
}

export interface DrainResult {
  readonly published: number;
  readonly failed: number;
  /** Claimed rows deleted before this worker could mark them; counted, not retried. */
  readonly vanished: number;
}

/**
 * Publishes claimed records. A broker failure leaves the record unpublished with the
 * failure recorded, so the next drain retries it — at-least-once delivery, which is why
 * every consumer is idempotent (AGENTS.md).
 */
export async function drain(
  store: OutboxStore,
  broker: EventBroker,
  options: { batchSize?: number; now?: () => Date } = {},
): Promise<DrainResult> {
  const now = options.now ?? (() => new Date());
  const batch = await store.claimUnpublished(options.batchSize ?? 100);

  let published = 0;
  let failed = 0;
  let vanished = 0;
  for (const record of batch) {
    try {
      await broker.publish(record);
      await store.markPublished(record.id, now());
      published += 1;
    } catch (error) {
      if (error instanceof OutboxRowGoneError) {
        vanished += 1;
        continue;
      }
      try {
        await store.recordFailure(record.id, error instanceof Error ? error.message : 'unknown');
        failed += 1;
      } catch (recordError) {
        // Deleted while its failure was being recorded: the row is gone, the rest of the batch is not.
        if (!(recordError instanceof OutboxRowGoneError)) throw recordError;
        vanished += 1;
      }
    }
  }
  return { published, failed, vanished };
}
