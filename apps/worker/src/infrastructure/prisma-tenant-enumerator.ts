import type { PrismaClient } from '@healer/prisma-client';
import type { TenantEnumerator } from '@healer/workflow';

/**
 * The control plane's own list of tenants (C-90, ADR 0018 §4). `tenant.tenant` is the one table
 * with no `tenant_id` column, so this is the sanctioned cross-tenant read: ids only, nothing a
 * request can influence.
 */
export class PrismaTenantEnumerator implements TenantEnumerator {
  constructor(private readonly prisma: PrismaClient) {}

  async activeTenantIds(): Promise<readonly string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }
}
