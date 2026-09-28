import { NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type Evidence as EvidenceRow, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import type { EvidenceRepository, NewEvidence } from '../domain/repository.js';
import type { Evidence, EvidenceExcerpt } from '../domain/types.js';
import { evidenceDetachedEvent, evidenceRecordedEvent } from '../domain/events.js';

/** Reconstructs the `excerpt`/`excerptTruncated` union from the two flat columns Postgres holds. */
export function toDomain(row: EvidenceRow): Evidence {
  const excerptFields: EvidenceExcerpt =
    row.excerpt === null
      ? { excerpt: null, excerptTruncated: false }
      : { excerpt: row.excerpt, excerptTruncated: row.excerptTruncated };
  return {
    ...excerptFields,
    id: row.id,
    tenantId: row.tenantId,
    issueId: row.issueId,
    type: row.type,
    sourceSystem: row.sourceSystem,
    sourceRef: row.sourceRef,
    sourceLabel: row.sourceLabel,
    payload: row.payload as Readonly<Record<string, unknown>>,
    producedByStep: row.producedByStep,
    refState: row.refState,
    observedAt: row.observedAt,
    receivedAt: row.receivedAt,
    expiresAt: row.expiresAt,
  };
}

export class PrismaEvidenceRepository implements EvidenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(evidence: TenantScoped<NewEvidence>): Promise<Evidence> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.evidence.create({
        data: {
          id: evidence.id,
          tenantId: evidence.tenantId,
          issueId: evidence.issueId,
          type: evidence.type,
          sourceSystem: evidence.sourceSystem,
          sourceRef: evidence.sourceRef,
          sourceLabel: evidence.sourceLabel,
          excerpt: evidence.excerpt,
          excerptTruncated: evidence.excerptTruncated,
          payload: evidence.payload as Prisma.InputJsonValue,
          producedByStep: evidence.producedByStep,
          observedAt: evidence.observedAt,
          expiresAt: evidence.expiresAt,
        },
      });
      const recorded = toDomain(row);
      // Same transaction as the row it describes (001 T013, 012 FR-031) — see
      // PrismaIssueRepository.create() for the guarantee this exists to keep.
      await enqueue(new PrismaOutboxTransaction(tx), evidenceRecordedEvent(recorded));
      return recorded;
    });
  }

  async findById(where: TenantScoped<{ readonly id: string }>): Promise<Evidence | null> {
    // The composite unique key, not a plain `findUnique({ where: { id } })` filtered afterward —
    // tenantId is part of the query itself, never a post-fetch check (security-and-tenancy.md).
    const row = await this.prisma.evidence.findUnique({
      where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
    });
    return row === null ? null : toDomain(row);
  }

  /**
   * Idempotent: only a `linked` record is updated, so a second call (a retried job, two
   * overlapping retention runs) changes nothing and publishes nothing — the row comes back as it
   * is. The trigger accepts `detached -> detached`, so it is this predicate, not the database, that
   * keeps `EvidenceDetached` from being published twice.
   */
  async detach(where: TenantScoped<{ readonly id: string }>): Promise<Evidence> {
    return this.prisma.$transaction(async (tx) => {
      const key = { id_tenantId: { id: where.id, tenantId: where.tenantId } };
      const changed = await tx.evidence.updateMany({
        where: { id: where.id, tenantId: where.tenantId, refState: 'linked' },
        data: { refState: 'detached' },
      });
      const row = await tx.evidence.findUnique({ where: key });
      if (row === null) throw new NotFoundError('Evidence');
      const detached = toDomain(row);
      if (changed.count > 0) {
        await enqueue(new PrismaOutboxTransaction(tx), evidenceDetachedEvent(detached));
      }
      return detached;
    });
  }

  async listByIssue(
    where: TenantScoped<{ readonly issueId: string; readonly type?: Evidence['type'] }>,
  ): Promise<readonly Evidence[]> {
    const rows = await this.prisma.evidence.findMany({
      where: {
        tenantId: where.tenantId,
        issueId: where.issueId,
        ...(where.type !== undefined ? { type: where.type } : {}),
      },
      orderBy: { observedAt: 'asc' },
    });
    return rows.map(toDomain);
  }
}
