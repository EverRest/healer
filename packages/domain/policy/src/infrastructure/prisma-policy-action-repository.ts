import type { PrismaClient } from '@healer/prisma-client';
import type { ActionClass } from '../domain/action-class.js';
import type { PolicyAction, PolicyActionRepository } from '../domain/policy-action-repository.js';

function toDomain(row: {
  actionKey: string;
  actionClass: string;
  mutating: boolean;
  owningSpec: string;
  introducedAt: Date;
}): PolicyAction {
  return {
    actionKey: row.actionKey,
    actionClass: row.actionClass as ActionClass,
    mutating: row.mutating,
    owningSpec: row.owningSpec,
    introducedAt: row.introducedAt,
  };
}

/**
 * `policy_action` (T014, data-model.md). Global, not tenant-scoped — no `TenantContext` parameter
 * here, unlike every other repository method this batch touches (T015).
 */
export class PrismaPolicyActionRepository implements PolicyActionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByKey(actionKey: string): Promise<PolicyAction | null> {
    const row = await this.prisma.policyAction.findUnique({ where: { actionKey } });
    return row === null ? null : toDomain(row);
  }

  async list(): Promise<readonly PolicyAction[]> {
    const rows = await this.prisma.policyAction.findMany({ orderBy: { actionKey: 'asc' } });
    return rows.map(toDomain);
  }
}
