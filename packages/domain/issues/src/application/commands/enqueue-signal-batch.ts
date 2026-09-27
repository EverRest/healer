import { scope, type TenantContext } from '@healer/shared';
import type { Signal } from '../../domain/signal.js';
import type { SignalQueue } from '../../domain/signal-queue.js';

export const MAX_SIGNAL_BATCH_SIZE = 1000;

export class SignalBatchTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`signal batch of ${size} exceeds the maximum of ${MAX_SIGNAL_BATCH_SIZE}`);
    this.name = 'SignalBatchTooLargeError';
  }
}

/**
 * Validate and enqueue a batch of signals (001 T019, FR-019). Never calls `ingestSignal` itself —
 * only enqueues, so a slow or failing signal can never block the HTTP response or the provider.
 */
export async function enqueueSignalBatch(
  queue: SignalQueue,
  context: TenantContext,
  signals: readonly Signal[],
): Promise<number> {
  if (signals.length > MAX_SIGNAL_BATCH_SIZE) throw new SignalBatchTooLargeError(signals.length);
  await queue.enqueueBatch(signals.map((signal) => scope(context, signal)));
  return signals.length;
}
