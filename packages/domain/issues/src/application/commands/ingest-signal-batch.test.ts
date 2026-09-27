import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import type { SignalQueue } from '../../domain/signal-queue.js';
import type { Signal } from '../../domain/signal.js';
import {
  DuplicateDeliveryError,
  type IngestionDelivery,
  type IngestionDeliveryRepository,
  type NewIngestionDelivery,
} from '../../domain/ingestion-delivery.js';
import { ingestSignalBatch } from './ingest-signal-batch.js';

const TENANT_ID = '00000000-0000-0000-8000-0000000000a1';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const DELIVERY = { provider: 'sentry', deliveryId: 'delivery-1' };

function signal(component: string): Signal {
  return {
    observedAt: new Date('2026-01-01T00:00:00Z'),
    component,
    environment: 'prod',
    errorSignature: { exceptionType: 'X' },
  };
}

function fakeQueue(): SignalQueue & { batches: unknown[][] } {
  const batches: unknown[][] = [];
  return {
    batches,
    enqueueBatch: (signals) => {
      batches.push([...signals]);
      return Promise.resolve();
    },
  };
}

function fakeDeliveries(
  seed: IngestionDelivery[] = [],
): IngestionDeliveryRepository & { recorded: NewIngestionDelivery[] } {
  const stored: IngestionDelivery[] = [...seed];
  const recorded: NewIngestionDelivery[] = [];
  return {
    recorded,
    findByDeliveryId: async (where) => {
      const found = stored.find(
        (d) =>
          d.tenantId === where.tenantId &&
          d.provider === where.provider &&
          d.deliveryId === where.deliveryId,
      );
      return found ?? null;
    },
    recordDelivery: async (delivery) => {
      recorded.push(delivery);
      const row = { ...delivery, receivedAt: new Date() };
      stored.push(row);
      return row;
    },
  };
}

describe('ingestSignalBatch (001 T020/T021, FR-004, R-09)', () => {
  it('enqueues and records a new delivery, returning duplicate: false', async () => {
    const queue = fakeQueue();
    const deliveries = fakeDeliveries();

    const result = await ingestSignalBatch(queue, deliveries, CONTEXT, DELIVERY, [
      signal('a'),
      signal('b'),
    ]);

    expect(result).toEqual({ accepted: 2, duplicate: false });
    expect(queue.batches).toHaveLength(1);
    expect(deliveries.recorded).toHaveLength(1);
    expect(deliveries.recorded[0]).toMatchObject({
      provider: 'sentry',
      deliveryId: 'delivery-1',
      signalCount: 2,
      outcome: 'accepted',
    });
  });

  it('the same delivery posted twice returns duplicate: true and never enqueues the second time', async () => {
    const queue = fakeQueue();
    const deliveries = fakeDeliveries();

    const first = await ingestSignalBatch(queue, deliveries, CONTEXT, DELIVERY, [
      signal('a'),
      signal('b'),
      signal('c'),
    ]);
    const second = await ingestSignalBatch(queue, deliveries, CONTEXT, DELIVERY, [
      signal('a'),
      signal('b'),
      signal('c'),
    ]);

    expect(first).toEqual({ accepted: 3, duplicate: false });
    // Counts unchanged (T020's own wording): the duplicate reports the original count, not a
    // fresh one, and nothing about the second call's signals was ever enqueued.
    expect(second).toEqual({ accepted: 3, duplicate: true });
    expect(queue.batches).toHaveLength(1);
  });

  it('a different delivery id for the same provider is not treated as a duplicate', async () => {
    const queue = fakeQueue();
    const deliveries = fakeDeliveries();

    await ingestSignalBatch(queue, deliveries, CONTEXT, DELIVERY, [signal('a')]);
    const result = await ingestSignalBatch(
      queue,
      deliveries,
      CONTEXT,
      { provider: 'sentry', deliveryId: 'delivery-2' },
      [signal('b')],
    );

    expect(result).toEqual({ accepted: 1, duplicate: false });
    expect(queue.batches).toHaveLength(2);
  });

  it('the same delivery id from two different providers is not treated as a duplicate', async () => {
    const queue = fakeQueue();
    const deliveries = fakeDeliveries();

    await ingestSignalBatch(queue, deliveries, CONTEXT, DELIVERY, [signal('a')]);
    const result = await ingestSignalBatch(
      queue,
      deliveries,
      CONTEXT,
      { provider: 'datadog', deliveryId: DELIVERY.deliveryId },
      [signal('b')],
    );

    expect(result).toEqual({ accepted: 1, duplicate: false });
    expect(queue.batches).toHaveLength(2);
  });

  it('a concurrent recordDelivery conflict is swallowed — the enqueue already happened and must not be lost', async () => {
    const queue = fakeQueue();
    const deliveries = fakeDeliveries();
    deliveries.recordDelivery = async () => {
      throw new DuplicateDeliveryError();
    };

    const result = await ingestSignalBatch(queue, deliveries, CONTEXT, DELIVERY, [signal('a')]);

    // This request's own enqueue succeeded — from its perspective this was not a duplicate,
    // even though a concurrent racer's recordDelivery won the unique-constraint race (FR-019
    // prioritizes never losing a signal over never double-processing one).
    expect(result).toEqual({ accepted: 1, duplicate: false });
    expect(queue.batches).toHaveLength(1);
  });
});
