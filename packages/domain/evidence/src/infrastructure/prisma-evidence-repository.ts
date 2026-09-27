import { NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type Evidence as EvidenceRow, type PrismaClient } from '@healer/prisma-client';
import type { EvidenceRepository, NewEvidence } from '../domain/repository.js';
import type { Evidence, EvidenceExcerpt } from '../domain/types.js';

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
    const row = await this.prisma.evidence.create({
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
    return toDomain(row);
  }

  async findById(where: TenantScoped<{ readonly id: string }>): Promise<Evidence | null> {
    // The composite unique key, not a plain `findUnique({ where: { id } })` filtered afterward —
    // tenantId is part of the query itself, never a post-fetch check (security-and-tenancy.md).
    const row = await this.prisma.evidence.findUnique({
      where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
    });
    return row === null ? null : toDomain(row);
  }

  async detach(where: TenantScoped<{ readonly id: string }>): Promise<Evidence> {
    try {
      const row = await this.prisma.evidence.update({
        where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
        data: { refState: 'detached' },
      });
      return toDomain(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundError('Evidence');
      }
      throw error;
    }
  }
}
