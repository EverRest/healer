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

export type IssueRelationshipKind = 'related' | 'recurrence_of' | 'merged_into';

/** A row in `issue_relationship` (data-model.md) — `rule` names the deterministic rule (or
 * `human`) that produced it, so it can be explained and recomputed, never a model's guess. */
export interface IssueRelationship {
  readonly id: string;
  readonly tenantId: string;
  readonly issueId: string;
  readonly otherIssueId: string;
  readonly kind: IssueRelationshipKind;
  readonly rule: string;
  readonly createdAt: Date;
}

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
  /** Set when `state` moves to `resolved`, cleared on reopen — FR-005's reopen window (001 T022). */
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
}

/** The three relationship projections `contracts/openapi.yaml`'s `Issue` schema names —
 * "live", so a `removed_at`-marked (undone/withdrawn) row never appears. */
export interface IssueRelationshipProjection {
  readonly mergedIntoId: string | null;
  readonly recurrenceOfId: string | null;
  readonly relatedIssueIds: readonly string[];
}

/**
 * `mergedIntoId`/`recurrenceOfId` (001 T040, FR-020): both kinds are always written with *this*
 * issue as the subject (`issueId`) — `create`'s `recurrenceOf` path, and 001 T049's future merge
 * path, both point the relationship *away from* the issue that changed. `relatedIssueIds` is
 * different: a correlation names either issue as `issueId`, so both directions collect into it.
 * At most one live `recurrence_of`/`merged_into` row can ever name this issue as subject — the
 * partial unique indexes `issue_relationship_tenant_id_issue_id_kind_recurrence_key`/`_merged_key`
 * are the actual guarantee; `[0]` here just reads what they already ensure can only be one row.
 */
export function projectIssueRelationships(
  issueId: string,
  relationships: readonly IssueRelationship[],
): IssueRelationshipProjection {
  const asSubject = (kind: IssueRelationshipKind) =>
    relationships.find((r) => r.issueId === issueId && r.kind === kind)?.otherIssueId ?? null;

  const relatedIssueIds = relationships
    .filter((r) => r.kind === 'related')
    .map((r) => (r.issueId === issueId ? r.otherIssueId : r.issueId));

  return {
    mergedIntoId: asSubject('merged_into'),
    recurrenceOfId: asSubject('recurrence_of'),
    relatedIssueIds,
  };
}
