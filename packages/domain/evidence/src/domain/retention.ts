import type { TenantScoped } from '@healer/shared';

/** Evidence past `expires_at`, and whether any conclusion still cites it (001 T052). */
export interface ExpiredEvidence {
  readonly id: string;
  /** At least one `evidence_link` names this record — FR-009: that conclusion needs its support. */
  readonly referenced: boolean;
}

/**
 * Retention as the database sees it (001 T052, R-04, R-10, FR-009): what has expired, and the one
 * destructive act the append-only rules otherwise forbid. `detach` is the existing
 * `EvidenceRepository.detach` — kept out of this interface so the two cannot drift.
 */
export interface EvidenceRetentionRepository {
  /**
   * Records past `expires_at` (which is set from `received_at`, never the source clock — R-10) that
   * retention still has work on: every unreferenced one, and the referenced ones not yet detached.
   * Referenced-and-already-detached is finished, so a second run converges instead of repeating.
   */
  findExpired(
    where: TenantScoped<{ readonly now: Date; readonly limit: number }>,
  ): Promise<readonly ExpiredEvidence[]>;
  /**
   * Deletes one expired record **only if nothing cites it**, and writes the audit entry that says
   * so in the same transaction. Returns `false` — without deleting — if it is cited, no longer
   * expired, or already gone: the check is inside the delete, not a read before it, so a link
   * appended after `findExpired` cannot be orphaned.
   */
  purge(where: TenantScoped<{ readonly id: string; readonly now: Date }>): Promise<boolean>;
}
