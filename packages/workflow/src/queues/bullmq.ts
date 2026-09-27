import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import { QUEUE_CLASSES, type QueueClass, jobOptionsFor, withWallClock } from './index.js';

/**
 * BullMQ wiring (012 T015). Thin on purpose: the policy — classes, concurrency, retry,
 * dead-letter behaviour, wall-clock budget — lives in `./index.ts`, so it is testable
 * without Redis, and this file only connects it.
 *
 * Constitution VI: no Temporal. What makes that sufficient is that no processor waits;
 * every long wait is a persisted state plus an inbound callback (ADR 0003), and the
 * wall-clock wrapper below is the runtime half of enforcing it.
 */
export interface QueueConnection {
  readonly url: string;
}

/**
 * `enableOfflineQueue: false` (001 T019 review): ioredis's default buffers a command in memory
 * while disconnected and only sends it once reconnected. Without this, a command issued during
 * an outage can sit buffered and fire *later*, after a caller has already given up on it and
 * moved on — a silent, delayed side effect rather than a clean failure. This alone does not make
 * `queue.add()` fail fast on a cold-start outage: `Queue.add()` first awaits the client reaching
 * `'ready'`, which ioredis's default retry strategy never gives up on, so it still hangs — a
 * caller that needs a bounded wait (`BullmqSignalQueue`, FR-019 "never blocks the provider")
 * wraps its own call in an explicit timeout instead of relying on this setting alone.
 */
export function createQueue(queue: QueueClass, connection: QueueConnection): Queue {
  return new Queue(queue, {
    connection: { url: connection.url, enableOfflineQueue: false },
    defaultJobOptions: jobOptionsFor(queue) as JobsOptions,
  });
}

/**
 * Creates a worker whose handler runs under the queue's declared budget. There is no
 * overload that skips the budget: a processor that can opt out is a processor that will.
 */
export function createWorker<T = unknown, R = unknown>(
  queue: QueueClass,
  connection: QueueConnection,
  handler: (job: Job<T>) => Promise<R>,
): Worker<T, R> {
  return new Worker<T, R>(queue, (job) => withWallClock(queue, () => handler(job)), {
    connection: { url: connection.url },
    concurrency: QUEUE_CLASSES[queue].concurrency,
  });
}

/** Dead letters are observable (T015): this is the number an operator alerts on. */
export async function deadLetterDepth(queue: Queue): Promise<number> {
  return queue.getFailedCount();
}
