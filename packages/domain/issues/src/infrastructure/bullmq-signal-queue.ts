import { randomUUID } from 'node:crypto';
import { currentCorrelationId, type TenantScoped } from '@healer/shared';
import { createQueue, type QueueConnection } from '@healer/workflow';
import type { Signal } from '../domain/signal.js';
import type { SignalQueue } from '../domain/signal-queue.js';

/**
 * One job per signal, not one job per batch (001 T019): a malformed signal's own retries
 * (`ingestion` queue class, 5 attempts) never retry its siblings too. All jobs from one batch
 * share a single `correlationId` — one per HTTP request, not one per signal — so every job this
 * delivery produced can be traced back to the request that accepted it.
 */
export interface SignalJobData {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly signal: Omit<Signal, 'observedAt'> & { readonly observedAt: string };
}

/**
 * Thrown when the queue could not be reached within budget (001 T019 review) — the caller (the
 * ingest controller) is expected to turn this into a 503, never a hang or an unhandled 500.
 */
export class SignalQueueUnavailableError extends Error {
  constructor(cause: unknown) {
    super('signal queue did not respond within budget — Redis may be unreachable');
    this.name = 'SignalQueueUnavailableError';
    this.cause = cause;
  }
}

// BullMQ's `Queue.add`/`addBulk` first await the underlying Redis client reaching `'ready'`,
// and ioredis's default retry strategy never gives up on a cold-start outage — confirmed
// empirically that without a bound, an enqueue against an unreachable Redis hangs indefinitely
// rather than rejecting. FR-019 ("never blocks the provider") needs a bounded wait here, since
// nothing upstream of this class provides one.
const ENQUEUE_TIMEOUT_MS = 3_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    throw new SignalQueueUnavailableError(error);
  } finally {
    clearTimeout(timer!);
  }
}

export class BullmqSignalQueue implements SignalQueue {
  private readonly queue: ReturnType<typeof createQueue>;

  constructor(connection: QueueConnection) {
    this.queue = createQueue('ingestion', connection);
  }

  async enqueueBatch(signals: readonly TenantScoped<Signal>[]): Promise<void> {
    if (signals.length === 0) return;
    const correlationId = currentCorrelationId() ?? randomUUID();
    // `addBulk` pipelines every job over a single connection round trip — not the same as a
    // MULTI/EXEC transaction (a per-job script error fails only that job), but it removes the
    // real risk of N separate `.add()` calls: a dropped connection or timeout partway through
    // leaving some signals enqueued and others never sent at all.
    const jobs = signals.map((signal) => {
      const { tenantId, ...rest } = signal;
      const data: SignalJobData = {
        tenantId,
        correlationId,
        // BullMQ JSON-serializes job data; a Date does not round-trip.
        signal: { ...rest, observedAt: rest.observedAt.toISOString() },
      };
      return { name: 'signal', data };
    });
    await withTimeout(this.queue.addBulk(jobs), ENQUEUE_TIMEOUT_MS);
  }
}
