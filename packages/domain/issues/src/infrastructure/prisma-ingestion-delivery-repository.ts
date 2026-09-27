import {
  Prisma,
  type IngestionDelivery as DeliveryRow,
  type PrismaClient,
} from '@healer/prisma-client';
import type { TenantScoped } from '@healer/shared';
import {
  DuplicateDeliveryError,
  type IngestionDelivery,
  type IngestionDeliveryRepository,
  type NewIngestionDelivery,
} from '../domain/ingestion-delivery.js';

function toDomain(row: DeliveryRow): IngestionDelivery {
  return {
    id: row.id,
    tenantId: row.tenantId,
    provider: row.provider,
    deliveryId: row.deliveryId,
    receivedAt: row.receivedAt,
    signalCount: row.signalCount,
    outcome: row.outcome,
  };
}

export class PrismaIngestionDeliveryRepository implements IngestionDeliveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByDeliveryId(
    where: TenantScoped<{ readonly provider: string; readonly deliveryId: string }>,
  ): Promise<IngestionDelivery | null> {
    const row = await this.prisma.ingestionDelivery.findUnique({
      where: {
        tenantId_provider_deliveryId: {
          tenantId: where.tenantId,
          provider: where.provider,
          deliveryId: where.deliveryId,
        },
      },
    });
    return row === null ? null : toDomain(row);
  }

  // The unique constraint is the actual safety net (same precedent as
  // `PrismaNormalisationRulesetRepository.publish`), not a read-then-insert check: P2002
  // translates to the port-level `DuplicateDeliveryError` rather than leaking a Prisma type.
  async recordDelivery(delivery: TenantScoped<NewIngestionDelivery>): Promise<IngestionDelivery> {
    try {
      const row = await this.prisma.ingestionDelivery.create({
        data: {
          id: delivery.id,
          tenantId: delivery.tenantId,
          provider: delivery.provider,
          deliveryId: delivery.deliveryId,
          signalCount: delivery.signalCount,
          outcome: delivery.outcome,
        },
      });
      return toDomain(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateDeliveryError();
      }
      throw error;
    }
  }
}
