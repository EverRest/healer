import type { TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import type { AutonomyEpochRepository } from '../domain/autonomy-epoch-repository.js';

/** See `AutonomyEpochRepository`'s doc comment: no row exists until Phase 4's `RevokeAutonomy`
 *  writes one, so absence reads as epoch `0`, not an error. */
export class PrismaAutonomyEpochRepository implements AutonomyEpochRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async current(where: TenantScoped<object>): Promise<bigint> {
    const row = await this.prisma.autonomyEpoch.findUnique({ where: { tenantId: where.tenantId } });
    return row?.epoch ?? 0n;
  }
}
