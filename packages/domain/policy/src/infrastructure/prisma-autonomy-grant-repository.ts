import { currentCorrelationId, NotFoundError, type TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import { autonomyGrantedEvent, autonomyRevokedEvent } from '../domain/events.js';
import {
  GrantAlreadyRevokedError,
  type AutonomyGrant,
  type AutonomyGrantRepository,
  type NewAutonomyGrant,
  type RevokeAutonomyGrant,
} from '../domain/autonomy-grant-repository.js';
import { recordAuditEntry } from './record-audit-entry.js';
import { bumpAutonomyEpochInTx } from './bump-autonomy-epoch.js';

/** Mirrors `prisma-policy-ruleset-repository.ts`'s `assertCorrelated` — `create`/`revoke` both
 *  publish an event, so both need an active correlation scope before the transaction opens. */
function assertCorrelated(): void {
  if (currentCorrelationId() === undefined) {
    throw new Error(
      'GrantAutonomy/RevokeAutonomy publish AutonomyGranted/AutonomyRevoked: call inside a correlated scope (withCorrelation)',
    );
  }
}

interface GrantRow {
  readonly id: string;
  readonly componentId: string | null;
  readonly environment: string | null;
  readonly issueKind: string | null;
  readonly actionKey: string;
  readonly level: number;
  readonly grantedBy: string;
  readonly grantedAt: Date;
  readonly revokedBy: string | null;
  readonly revokedAt: Date | null;
}

function toDomain(row: GrantRow): AutonomyGrant {
  return {
    id: row.id,
    ...(row.componentId !== null ? { componentId: row.componentId } : {}),
    ...(row.environment !== null ? { environment: row.environment } : {}),
    ...(row.issueKind !== null ? { issueKind: row.issueKind } : {}),
    actionKey: row.actionKey,
    level: row.level,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    ...(row.revokedBy !== null ? { revokedBy: row.revokedBy } : {}),
    ...(row.revokedAt !== null ? { revokedAt: row.revokedAt } : {}),
  };
}

/** `policy.autonomy_grant` (T039, data-model.md). `create`/`revoke` each write the grant (or its
 *  revocation), the audit entry and the outbox event in one transaction — `revoke` additionally
 *  bumps `autonomy_epoch` in the same transaction (T043, R-07): a revocation that committed the
 *  grant's terminal state without also committing the epoch bump would leave an outstanding
 *  approval checking a stale-but-unbumped epoch, silently valid.
 */
export class PrismaAutonomyGrantRepository implements AutonomyGrantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findActive(
    where: TenantScoped<{ readonly actionKey: string }>,
  ): Promise<readonly AutonomyGrant[]> {
    const rows = await this.prisma.autonomyGrant.findMany({
      where: { tenantId: where.tenantId, actionKey: where.actionKey, revokedAt: null },
    });
    return rows.map(toDomain);
  }

  async findById(where: TenantScoped<{ readonly id: string }>): Promise<AutonomyGrant | null> {
    const row = await this.prisma.autonomyGrant.findFirst({
      where: { id: where.id, tenantId: where.tenantId },
    });
    return row === null ? null : toDomain(row);
  }

  async list(where: TenantScoped<object>): Promise<readonly AutonomyGrant[]> {
    const rows = await this.prisma.autonomyGrant.findMany({
      where: { tenantId: where.tenantId },
      orderBy: { grantedAt: 'desc' },
    });
    return rows.map(toDomain);
  }

  async create(where: TenantScoped<NewAutonomyGrant>): Promise<AutonomyGrant> {
    assertCorrelated();
    const event = autonomyGrantedEvent(where.tenantId, {
      scope: {
        grantId: where.id,
        ...(where.componentId !== undefined ? { componentId: where.componentId } : {}),
        ...(where.environment !== undefined ? { environment: where.environment } : {}),
        ...(where.issueKind !== undefined ? { issueKind: where.issueKind } : {}),
      },
      actionKey: where.actionKey,
      level: where.level,
      epoch: 0n,
    });

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.autonomyGrant.create({
        data: {
          id: where.id,
          tenantId: where.tenantId,
          componentId: where.componentId ?? null,
          environment: where.environment ?? null,
          issueKind: where.issueKind ?? null,
          actionKey: where.actionKey,
          level: where.level,
          grantedBy: where.grantedBy,
          grantedAt: where.grantedAt,
        },
      });
      await recordAuditEntry(tx, where.auditEntry);
      await enqueue(new PrismaOutboxTransaction(tx), event);
      return created;
    });

    return toDomain(row);
  }

  async revoke(where: TenantScoped<RevokeAutonomyGrant>): Promise<AutonomyGrant> {
    assertCorrelated();

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.autonomyGrant.findFirst({
        where: { id: where.id, tenantId: where.tenantId },
      });
      if (existing === null) throw new NotFoundError('autonomy_grant');
      if (existing.revokedAt !== null) throw new GrantAlreadyRevokedError(where.id);

      const updated = await tx.autonomyGrant.update({
        where: { id: where.id },
        data: { revokedBy: where.revokedBy, revokedAt: where.revokedAt },
      });

      const epoch = await bumpAutonomyEpochInTx(
        tx,
        { tenantId: where.tenantId, bumpedBy: where.revokedBy, bumpReason: where.bumpReason },
        where.revokedAt,
      );

      await recordAuditEntry(tx, where.auditEntry);
      await enqueue(
        new PrismaOutboxTransaction(tx),
        autonomyRevokedEvent(where.tenantId, {
          scope: {
            grantId: where.id,
            ...(updated.componentId !== null ? { componentId: updated.componentId } : {}),
            ...(updated.environment !== null ? { environment: updated.environment } : {}),
            ...(updated.issueKind !== null ? { issueKind: updated.issueKind } : {}),
          },
          actionKey: updated.actionKey,
          level: updated.level,
          epoch,
        }),
      );

      return toDomain(updated);
    });
  }
}
