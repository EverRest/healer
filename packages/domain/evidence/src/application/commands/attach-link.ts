import { scope, type TenantContext } from '@healer/shared';
import type { EvidenceLinkRepository, NewEvidenceLink } from '../../domain/link-repository.js';
import type { EvidenceLink } from '../../domain/types.js';

/**
 * `AttachLink` (001 T028, `plan.md`'s named application layer). Thin on purpose: the two real
 * guarantees — the closed `supports`/`contradicts`/`contextualises` relation set, and uniqueness
 * per `(evidence, conclusion, relation)` — are already enforced where enforcement actually holds
 * (the `EvidenceRelation` type at compile time; the DB's own unique constraint, translated to
 * `DuplicateEvidenceLinkError` in `PrismaEvidenceLinkRepository`, 001 T028). This function exists
 * so a caller has one named place to call, matching `RecordEvidence`/`DetachEvidence`, not
 * because there is more validation to add on top of what the repository already does.
 */
export async function attachLink(
  repo: EvidenceLinkRepository,
  context: TenantContext,
  link: NewEvidenceLink,
): Promise<EvidenceLink> {
  return repo.write(scope(context, link));
}
