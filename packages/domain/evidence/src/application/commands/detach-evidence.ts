import { scope, type TenantContext } from '@healer/shared';
import type { EvidenceRepository } from '../../domain/repository.js';
import type { Evidence } from '../../domain/types.js';

/**
 * `DetachEvidence` (001 T030, `plan.md`'s named application layer, R-04, FR-010). Thin on
 * purpose, same reasoning as `AttachLink`: the real guarantee — `linked -> detached` is the one
 * mutation this repository can perform, excerpt and `source_label` untouched, every conclusion
 * built on this evidence stays exactly as linked as it was — is already enforced where it holds
 * (`EvidenceRepository.detach`, 001 T006; the FK from `evidence_link` to `evidence` has no
 * `ON DELETE CASCADE` to break, because nothing here ever deletes the row). This function exists
 * so a caller has one named place to call, not because there is more to add on top.
 */
export async function detachEvidence(
  repo: EvidenceRepository,
  context: TenantContext,
  id: string,
): Promise<Evidence> {
  return repo.detach(scope(context, { id }));
}
