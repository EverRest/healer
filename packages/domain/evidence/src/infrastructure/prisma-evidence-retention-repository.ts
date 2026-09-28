import { randomUUID } from 'node:crypto';
import type { TenantScoped } from '@healer/shared';
import { Prisma, withPrivilegedWrite, type PrismaClient } from '@healer/prisma-client';
import type { EvidenceRepository } from '../domain/repository.js';
import type { EvidenceRetentionRepository, ExpiredEvidence } from '../domain/retention.js';
import { PrismaEvidenceRepository } from './prisma-evidence-repository.js';

/** `actor_ref` of every retention audit entry (001 T052). */
const RETENTION_SWEEP = 'retention-sweep';

/**
 * ponytail: `evidence.retention_purge` is not a registered `policy_action.action_key` — 002's
 * closed list does not exist yet (the same gap `NewAuditEntry` documents). When it does, this is
 * the one place to register it.
 */
const PURGE_ACTION = 'evidence.retention_purge';

export class PrismaEvidenceRetentionRepository
  implements EvidenceRetentionRepository, Pick<EvidenceRepository, 'detach'>
{
  private readonly evidence: PrismaEvidenceRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.evidence = new PrismaEvidenceRepository(prisma);
  }

  /** The existing `linked -> detached` mutation, unchanged — retention adds nothing to it. */
  detach(where: TenantScoped<{ readonly id: string }>): ReturnType<EvidenceRepository['detach']> {
    return this.evidence.detach(where);
  }

  /**
   * Oldest expiry first, so a backlog larger than `limit` is worked through in order across runs.
   * `referenced-and-detached` is excluded: it is finished, and listing it would make every run
   * re-examine it forever.
   */
  async findExpired(
    where: TenantScoped<{ readonly now: Date; readonly limit: number }>,
  ): Promise<readonly ExpiredEvidence[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; referenced: boolean }[]>`
      SELECT e.id,
             EXISTS (
               SELECT 1 FROM "evidence"."evidence_link" l
               WHERE l.evidence_id = e.id AND l.tenant_id = e.tenant_id
             ) AS referenced
      FROM "evidence"."evidence" e
      WHERE e.tenant_id = ${where.tenantId}::uuid
        AND e.expires_at <= ${where.now}::timestamptz
        AND (
          NOT EXISTS (
            SELECT 1 FROM "evidence"."evidence_link" l
            WHERE l.evidence_id = e.id AND l.tenant_id = e.tenant_id
          )
          OR e.ref_state = 'linked'
        )
      ORDER BY e.expires_at, e.id
      LIMIT ${where.limit}`;
    return rows;
  }

  /**
   * One transaction, opened by `withPrivilegedWrite` so the append-only bypass is on for this
   * transaction only: delete only if expired and uncited, and write the audit entry. The uncited
   * check is in the `DELETE`'s own `WHERE`, not a read before it, so a link appended in between
   * cannot be orphaned; the `evidence_link` foreign key (`Restrict`) is the second wall behind it,
   * and it is the one that answers when a link is *uncommitted* at the moment of the delete.
   *
   * The audit entry carries the id and the fact — never the excerpt, payload or label.
   */
  async purge(where: TenantScoped<{ readonly id: string; readonly now: Date }>): Promise<boolean> {
    try {
      return await withPrivilegedWrite(this.prisma, async (tx) => {
        const deleted = await tx.$executeRaw`
          DELETE FROM "evidence"."evidence" e
          WHERE e.id = ${where.id}::uuid AND e.tenant_id = ${where.tenantId}::uuid
            AND e.expires_at <= ${where.now}::timestamptz
            AND NOT EXISTS (
              SELECT 1 FROM "evidence"."evidence_link" l
              WHERE l.evidence_id = e.id AND l.tenant_id = e.tenant_id
            )`;
        if (deleted === 0) return false;
        await tx.auditEntry.create({
          data: {
            id: randomUUID(),
            tenantId: where.tenantId,
            actorType: 'system',
            actorRef: RETENTION_SWEEP,
            action: PURGE_ACTION,
            targetType: 'evidence',
            targetId: where.id,
            reason: 'expires_at passed and no conclusion cites it',
            evidenceIds: [],
            outcome: 'purged',
          },
        });
        return true;
      });
    } catch (error) {
      // A link appended between the `NOT EXISTS` and the delete: the foreign key refuses. That is
      // the guarantee holding, not a failure — same answer as "cited".
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2003' || error.code === 'P2010')
      ) {
        const meta = error.meta as { code?: string } | undefined;
        if (error.code === 'P2003' || meta?.code === '23503') return false;
      }
      throw error;
    }
  }
}
