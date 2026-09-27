import type { TenantScoped } from '@healer/shared';
import type { Evidence, EvidenceExcerpt } from './types.js';

/**
 * What a caller supplies to record new evidence — everything except what the repository/DB
 * assigns (`receivedAt` defaults to now(), `refState` defaults to `linked`). `id` is supplied by
 * the caller: Prisma's `Evidence.id` has no `@default`, matching an identifier minted at the
 * point evidence is captured, not at the point it happens to be persisted.
 */
export type NewEvidence = EvidenceExcerpt & {
  readonly id: string;
  readonly issueId: string;
  readonly type: Evidence['type'];
  readonly sourceSystem: string;
  readonly sourceRef: string;
  readonly sourceLabel: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly producedByStep: string;
  readonly observedAt: Date;
  readonly expiresAt: Date;
};

/**
 * Write and read only (R-03, FR-010): there is no `update`. The one legitimate mutation —
 * `ref_state` moving `linked` to `detached` — gets its own narrow method rather than a generic
 * one that could be pointed at any field. The database enforces the identical constraint
 * independently (001 T003, append-only triggers): this interface not offering the shape is the
 * first of the two enforcements (docs/patterns.md "enforce twice where one mechanism is
 * bypassable"), not a substitute for the second.
 */
export interface EvidenceRepository {
  record(evidence: TenantScoped<NewEvidence>): Promise<Evidence>;
  findById(where: TenantScoped<{ readonly id: string }>): Promise<Evidence | null>;
  detach(where: TenantScoped<{ readonly id: string }>): Promise<Evidence>;
}
