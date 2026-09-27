// Mirrors prisma/schema.prisma's `issue` schema enums as plain string unions. Domain code cannot
// import `@prisma/client` (infrastructure-only, 00-core.md), so the closed list is declared here
// too — same pattern as `@healer/domain-evidence`'s `types.ts`.

export type IssueKind =
  | 'production_incident'
  | 'user_report'
  | 'monitoring_alert'
  | 'regression'
  | 'automated_detection'
  /** Terminates at human adjudication; never enters reproduction or change (FR-001a). */
  | 'knowledge_drift';

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Exactly the nine states in data-model.md's "State transitions" — the closed list this module
 * and `state-machine.ts` are the one authority for (00-core.md). There is no `closed` state.
 */
export type IssueState =
  | 'detected'
  | 'investigating'
  | 'diagnosed'
  | 'acting'
  | 'resolved'
  | 'needs_human'
  | 'stale'
  | 'merged'
  | 'removed';

export interface Issue {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: IssueKind;
  /** `Component` in 004 — never a service name. */
  readonly componentId: string | null;
  readonly environment: string;
  readonly severity: IssueSeverity;
  readonly state: IssueState;
  readonly fingerprint: string;
  /** Which `normalisation_ruleset` version produced the fingerprint (001 T011, R-01). */
  readonly rulesetVersion: number;
  readonly occurrenceCount: bigint;
  /** Source clock (R-10), not this system's receipt time. */
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  /** Set by the staleness job (R-11) — surfaced, never auto-resolving. */
  readonly staleAt: Date | null;
  readonly createdAt: Date;
}
