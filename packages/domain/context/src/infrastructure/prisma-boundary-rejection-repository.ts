import type { PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction, type DomainEvent } from '@healer/events';
import type { TenantScoped } from '@healer/shared';
import type {
  BoundaryRejection,
  BoundaryRejectionRepository,
  BoundaryRejectionSummary,
  NewBoundaryRejection,
} from '../domain/boundary-rejection-repository.js';

/** `items` is a window, not the whole history: `total` and `countsByRunner` are the full figures. */
const LIST_LIMIT = 200;

/**
 * `boundary_rejection` writes (003 T029, R-13). The row and the outbox event share one
 * transaction — the same shape as `PrismaPolicyRulesetRepository.publish`. Every query carries
 * `tenantId` at the query layer, never post-filtered.
 */
export class PrismaBoundaryRejectionRepository implements BoundaryRejectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(rejection: TenantScoped<NewBoundaryRejection>, event: DomainEvent): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.boundaryRejection.create({
        data: {
          id: rejection.id,
          tenantId: rejection.tenantId,
          runnerId: rejection.runnerId,
          passId: rejection.passId ?? null,
          contractVersion: rejection.contractVersion,
          schemaErrorPaths: [...rejection.schemaErrorPaths],
          payloadDigest: rejection.payloadDigest,
          byteSize: rejection.byteSize,
          receivedAt: rejection.receivedAt,
        },
      });
      await enqueue(new PrismaOutboxTransaction(tx), event);
    });
  }

  async list(
    where: TenantScoped<{ readonly runnerId?: string; readonly since?: Date }>,
  ): Promise<BoundaryRejectionSummary> {
    const filter = {
      tenantId: where.tenantId,
      ...(where.runnerId !== undefined ? { runnerId: where.runnerId } : {}),
      ...(where.since !== undefined ? { receivedAt: { gte: where.since } } : {}),
    };
    const [rows, grouped] = await Promise.all([
      this.prisma.boundaryRejection.findMany({
        where: filter,
        orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
        take: LIST_LIMIT,
      }),
      this.prisma.boundaryRejection.groupBy({
        by: ['runnerId'],
        where: filter,
        _count: { _all: true },
      }),
    ]);
    const countsByRunner = Object.fromEntries(grouped.map((g) => [g.runnerId, g._count._all]));
    const items: BoundaryRejection[] = rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      runnerId: r.runnerId,
      ...(r.passId !== null ? { passId: r.passId } : {}),
      contractVersion: r.contractVersion,
      schemaErrorPaths: r.schemaErrorPaths,
      payloadDigest: r.payloadDigest,
      byteSize: r.byteSize,
      receivedAt: r.receivedAt,
    }));
    return {
      items,
      total: grouped.reduce((n, g) => n + g._count._all, 0),
      countsByRunner,
    };
  }
}
