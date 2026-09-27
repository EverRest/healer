import { currentStep, type TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import {
  DuplicateEvidenceLinkError,
  type EvidenceLinkRepository,
  type NewEvidenceLink,
} from '../domain/link-repository.js';
import type { ConclusionType, EvidenceLink } from '../domain/types.js';

/** `@@unique([evidenceId, conclusionId, relation])` — confirmed empirically that Prisma reports
 *  the raw DB column names (snake_case) in `meta.target` here, not its own camelCase field names
 *  (same behaviour observed for `packages/domain/issues`' raw-SQL partial index). */
function isDuplicateLinkViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  return (
    Array.isArray(target) &&
    target.includes('evidence_id') &&
    target.includes('conclusion_id') &&
    target.includes('relation')
  );
}

export class PrismaEvidenceLinkRepository implements EvidenceLinkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async write(link: TenantScoped<NewEvidenceLink>): Promise<EvidenceLink> {
    const step = currentStep();
    if (step === undefined) {
      throw new Error(
        'EvidenceLinkRepository.write called outside any step context (FR-008, R-06) — ' +
          'wrap the call in withStep(...)',
      );
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        // `set_config(..., true)` is transaction-local, the same scoping `healer.privileged_write`
        // already uses — a parameterized call, not string interpolation into raw SQL, even though
        // `step` is an internal identifier rather than untrusted input.
        await tx.$executeRaw`SELECT set_config('healer.current_step', ${step}, true)`;
        const row = await tx.evidenceLink.create({
          data: {
            id: link.id,
            tenantId: link.tenantId,
            evidenceId: link.evidenceId,
            conclusionType: link.conclusionType,
            conclusionId: link.conclusionId,
            relation: link.relation,
            assertedByStep: step,
          },
        });
        return {
          id: row.id,
          tenantId: row.tenantId,
          evidenceId: row.evidenceId,
          conclusionType: row.conclusionType,
          conclusionId: row.conclusionId,
          relation: row.relation,
          assertedByStep: row.assertedByStep,
          assertedAt: row.assertedAt,
        };
      });
    } catch (error) {
      if (isDuplicateLinkViolation(error)) {
        throw new DuplicateEvidenceLinkError(link.evidenceId, link.conclusionId, link.relation);
      }
      throw error;
    }
  }

  async hasLinks(
    where: TenantScoped<{ readonly conclusionType: ConclusionType; readonly conclusionId: string }>,
  ): Promise<boolean> {
    // A `count` capped at 1, not "fetch and check length": FR-009 only ever asks "at least one?",
    // and a conclusion can legitimately accumulate many links over time.
    const count = await this.prisma.evidenceLink.count({
      where: {
        tenantId: where.tenantId,
        conclusionType: where.conclusionType,
        conclusionId: where.conclusionId,
      },
      take: 1,
    });
    return count > 0;
  }
}
