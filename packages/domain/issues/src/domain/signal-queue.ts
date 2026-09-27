import type { TenantScoped } from '@healer/shared';
import type { Signal } from './signal.js';

/**
 * Signals accepted for asynchronous ingestion (001 T019, FR-019). `POST /ingest/signals`'s only
 * job is to validate and enqueue — it never calls `ingestSignal` (001 T018) itself, and never
 * waits for anything downstream, so a slow or failing signal can never make the HTTP response (or
 * the provider waiting on it) block. Whatever drains this queue and actually calls `ingestSignal`
 * per item is 001 T024/T025's concern (malformed payloads, retry on downstream failure), not this
 * port's.
 *
 * `enqueueBatch` takes the whole batch, not one signal at a time (review finding): an
 * implementation that issues N separate round trips for N signals can fail partway through,
 * leaving some already enqueued when the caller sees the request as failed and — with no
 * idempotency key yet (that's 001 T020/T021) — retries the whole batch, double-enqueuing the
 * signals that had already landed. A single batched call is the unit that either lands or doesn't.
 */
export interface SignalQueue {
  enqueueBatch(signals: readonly TenantScoped<Signal>[]): Promise<void>;
}
