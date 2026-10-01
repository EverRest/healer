// Mirrors prisma/schema.prisma's `evidence` schema enums as plain string unions. Domain code
// cannot import `@prisma/client` (infrastructure-only, 00-core.md), so the closed list is
// declared here too; a mismatch between the two would surface the moment the repository (T006)
// tries to persist a value neither side recognises.

export type EvidenceType =
  | 'error_signature'
  | 'trace_shape'
  | 'metric_delta'
  | 'deploy_ref'
  | 'commit_ref'
  | 'test_result'
  | 'file_path'
  | 'tool_output_summary'
  | 'document_excerpt'
  | 'collection_gap'
  | 'budget_degradation'
  | 'graph_fact';

export type RefState = 'linked' | 'detached';

export type ConclusionType =
  | 'classification'
  | 'diagnosis'
  | 'hypothesis'
  | 'impact'
  | 'verification'
  | 'support_answer'
  | 'remediation';

export type EvidenceRelation = 'supports' | 'contradicts' | 'contextualises';

// `excerpt`/`excerptTruncated` as a discriminated union, not two independent fields: a row
// claiming `excerptTruncated: true` with no captured excerpt at all would be a silent, misleading
// claim in a system whose whole guarantee is "no claim without evidence" — the combination is
// unrepresentable rather than merely unexpected (same technique as
// packages/workflow/src/machine.ts's `WorkflowState`).
export type EvidenceExcerpt =
  | { readonly excerpt: null; readonly excerptTruncated: false }
  | { readonly excerpt: string; readonly excerptTruncated: boolean };

export type Evidence = EvidenceExcerpt & {
  readonly id: string;
  readonly tenantId: string;
  /**
   * Null only for the two discovery evidence types (`graph_fact`, `collection_gap` when written
   * by 004's discovery step) — 004 Phase 3 dropped the column's NOT NULL for exactly those two
   * types (migration `20261004000000_t018_t035_discovery_evidence_and_draft_checks`); every other
   * evidence type keeps an issue. `NewEvidence.issueId` stays `string`: 001's own recording path
   * (`recordEvidence`) always has an issue — only discovery's direct-transaction write path (which
   * bypasses this package's repository, see `packages/domain/architecture/src/infrastructure/`)
   * produces a null one.
   */
  readonly issueId: string | null;
  readonly type: EvidenceType;
  readonly sourceSystem: string;
  readonly sourceRef: string;
  /** Human-readable; survives detachment — "from logs, March" (R-04). */
  readonly sourceLabel: string;
  /**
   * Structured fields for `type`, schema-validated against 012's boundary schemas at the point
   * evidence is recorded (T027) — not enforced by this type, which only mirrors the shape Prisma
   * itself stores (`Json`).
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Which step observed this (R-06) — the producer, not the caller's say-so. */
  readonly producedByStep: string;
  readonly refState: RefState;
  readonly observedAt: Date;
  readonly receivedAt: Date;
  readonly expiresAt: Date;
};

export interface EvidenceLink {
  readonly id: string;
  readonly tenantId: string;
  readonly evidenceId: string;
  readonly conclusionType: ConclusionType;
  readonly conclusionId: string;
  readonly relation: EvidenceRelation;
  /** Must equal the step that executed the write — a mismatch is rejected (R-06). */
  readonly assertedByStep: string;
  readonly assertedAt: Date;
}
