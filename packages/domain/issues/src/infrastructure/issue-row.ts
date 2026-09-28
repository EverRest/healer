import type { Issue as IssueRow } from '@healer/prisma-client';
import type { Issue } from '../domain/issue.js';

/** The one place a Prisma `issue` row becomes the domain `Issue` — shared by every repository
 * in this folder so a new column is mapped once. */
export function toDomain(row: IssueRow): Issue {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    componentId: row.componentId,
    environment: row.environment,
    severity: row.severity,
    state: row.state,
    fingerprint: row.fingerprint,
    rulesetVersion: row.rulesetVersion,
    occurrenceCount: row.occurrenceCount,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    staleAt: row.staleAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}
