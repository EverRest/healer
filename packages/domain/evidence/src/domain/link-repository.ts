import type { TenantScoped } from '@healer/shared';
import type { ConclusionType, EvidenceLink, EvidenceRelation } from './types.js';

/**
 * What a caller supplies to write a link. Deliberately has no `assertedByStep` field: FR-008
 * requires the writer to take the executing step from the call context, never from an argument —
 * a field here would be a way to pass one, so there is no field (docs/patterns.md, make the
 * unsafe state unrepresentable). The database enforces the identical constraint independently
 * (001 T007, the `evidence_link_step_attribution` trigger) — this interface not offering the
 * shape is the first of the two enforcements, not a substitute for the second.
 */
export interface NewEvidenceLink {
  readonly id: string;
  readonly evidenceId: string;
  readonly conclusionType: ConclusionType;
  readonly conclusionId: string;
  readonly relation: EvidenceRelation;
}

/**
 * A second link naming the same `(evidenceId, conclusionId, relation)` (001 T028) — the DB's own
 * unique constraint, translated the same way `FingerprintAlreadyOpenError` translates its own
 * (`packages/domain/issues`). A given evidence/conclusion pair can still hold more than one
 * relation (`supports` *and* `contextualises`, say) — this rejects only the exact repeat, not the
 * pair.
 */
export class DuplicateEvidenceLinkError extends Error {
  constructor(
    readonly evidenceId: string,
    readonly conclusionId: string,
    readonly relation: EvidenceRelation,
  ) {
    super(`evidence ${evidenceId} already has a "${relation}" link to conclusion ${conclusionId}`);
    this.name = 'DuplicateEvidenceLinkError';
  }
}

/** Write, plus the one read `assertHasEvidence` (FR-009) needs: does this conclusion have any
 * link at all. There is no API for creating links retrospectively (R-06): `write` always uses the
 * step executing right now, from `@healer/shared`'s `currentStep()`. */
export interface EvidenceLinkRepository {
  write(link: TenantScoped<NewEvidenceLink>): Promise<EvidenceLink>;
  hasLinks(
    where: TenantScoped<{ readonly conclusionType: ConclusionType; readonly conclusionId: string }>,
  ): Promise<boolean>;
}
