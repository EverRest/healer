import type { TenantScoped } from '@healer/shared';

export type IngestionOutcome = 'accepted' | 'duplicate' | 'partial' | 'failed';

export interface IngestionDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly deliveryId: string;
  readonly receivedAt: Date;
  readonly signalCount: number;
  readonly outcome: IngestionOutcome;
}

export interface NewIngestionDelivery {
  readonly id: string;
  readonly provider: string;
  readonly deliveryId: string;
  readonly signalCount: number;
  readonly outcome: IngestionOutcome;
}

/**
 * Thrown when `recordDelivery` loses a race to record the same `(tenantId, provider,
 * deliveryId)` a concurrent request already claimed (001 T021) — a port-level error, not an
 * infrastructure one: application code catches this without depending on how a given
 * `IngestionDeliveryRepository` implementation enforces the constraint.
 */
export class DuplicateDeliveryError extends Error {
  constructor() {
    super('a delivery with this tenant, provider and delivery id was already recorded');
    this.name = 'DuplicateDeliveryError';
  }
}

/**
 * The idempotency key for signal ingestion (001 T020/T021, FR-004, R-09): the same delivery
 * posted twice is a no-op. Unique on `(tenantId, provider, deliveryId)` — enforced by the
 * database, not application discipline (data-model.md `issue.ingestion_delivery`).
 */
export interface IngestionDeliveryRepository {
  findByDeliveryId(
    where: TenantScoped<{ readonly provider: string; readonly deliveryId: string }>,
  ): Promise<IngestionDelivery | null>;
  recordDelivery(delivery: TenantScoped<NewIngestionDelivery>): Promise<IngestionDelivery>;
}
