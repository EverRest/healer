import type { TenantScoped } from '@healer/shared';
import type { EvidenceLinkRepository } from './link-repository.js';
import type { ConclusionType } from './types.js';

/**
 * FR-009: "any persisted conclusion ... MUST reference ≥ 1 evidence record. Persistence MUST fail
 * otherwise." Quickstart 9 names the code: `EVIDENCE_REQUIRED`.
 */
export class EvidenceRequiredError extends Error {
  constructor(
    readonly conclusionType: string,
    readonly conclusionId: string,
  ) {
    super(`EVIDENCE_REQUIRED: ${conclusionType} ${conclusionId} has no evidence_link`);
    this.name = 'EvidenceRequiredError';
  }
}

/**
 * The runtime half of FR-009 (the schema half is `gate-evidence`, 012 T031): a future conclusion
 * command calls this before — or in the same transaction as — persisting its conclusion row.
 * Depends only on `EvidenceLinkRepository`'s interface, never the concrete Prisma
 * implementation (backend-nestjs.md: domain and application depend on repository interfaces).
 */
export async function assertHasEvidence(
  repository: EvidenceLinkRepository,
  where: TenantScoped<{ readonly conclusionType: ConclusionType; readonly conclusionId: string }>,
): Promise<void> {
  const has = await repository.hasLinks(where);
  if (!has) throw new EvidenceRequiredError(where.conclusionType, where.conclusionId);
}
