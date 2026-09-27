import { currentStep, type TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import type { EvidenceLinkRepository, NewEvidenceLink } from '../domain/link-repository.js';
import type { ConclusionType, EvidenceLink } from '../domain/types.js';

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
    return this.prisma.$transaction(async (tx) => {
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
