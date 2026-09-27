import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import type { Signal } from '../../domain/signal.js';
import type { SignalQueue } from '../../domain/signal-queue.js';
import {
  DuplicateDeliveryError,
  type IngestionDeliveryRepository,
} from '../../domain/ingestion-delivery.js';
import { enqueueSignalBatch } from './enqueue-signal-batch.js';

export interface IngestSignalBatchResult {
  readonly accepted: number;
  readonly duplicate: boolean;
}

export interface DeliveryIdentity {
  readonly provider: string;
  readonly deliveryId: string;
}

/**
 * Idempotent enqueue (001 T020/T021, FR-004, R-09): the same delivery posted twice is a no-op —
 * the second call reports the original `accepted` count and never enqueues anything.
 *
 * Enqueue happens *before* recording the delivery, not after (a deliberate ordering, not an
 * oversight): if the process died between the two, a "record-first" ordering would have the
 * delivery marked accepted while nothing was ever actually enqueued — a silently lost batch,
 * which FR-019 ("must not lose events") rules out outright. This ordering's own failure mode is
 * milder: two truly concurrent identical deliveries can both pass the duplicate check and both
 * enqueue, with only one delivery row winning the unique-constraint race — a narrow, accepted
 * race (same precedent as the fingerprint's first-arrival race, QUESTIONS.md), not a lost signal.
 */
export async function ingestSignalBatch(
  queue: SignalQueue,
  deliveries: IngestionDeliveryRepository,
  context: TenantContext,
  delivery: DeliveryIdentity,
  signals: readonly Signal[],
): Promise<IngestSignalBatchResult> {
  const existing = await deliveries.findByDeliveryId(scope(context, delivery));
  if (existing) {
    return { accepted: existing.signalCount, duplicate: true };
  }

  const accepted = await enqueueSignalBatch(queue, context, signals);

  try {
    await deliveries.recordDelivery(
      scope(context, {
        id: randomUUID(),
        provider: delivery.provider,
        deliveryId: delivery.deliveryId,
        signalCount: accepted,
        outcome: 'accepted',
      }),
    );
  } catch (error) {
    if (!(error instanceof DuplicateDeliveryError)) throw error;
  }

  return { accepted, duplicate: false };
}
