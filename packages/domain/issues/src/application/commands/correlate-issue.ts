import { scope, type TenantContext } from '@healer/shared';
import { CORRELATION_RULE, CORRELATION_WINDOW_MS, correlates } from '../../domain/correlation.js';
import type { Issue, IssueRelationship } from '../../domain/issue.js';
import type { IssueRepository } from '../../domain/repository.js';

/**
 * `CorrelateIssue` (001 T039, FR-020, quickstart 26): finds every other open issue sharing
 * `componentId` and `environment` within the correlation window and records a `related`
 * relationship for each real match — `correlates()` is the final say on each candidate the
 * repository's own pre-filter query returns, never the query alone.
 *
 * Deliberately **not wired into `ingestSignal`'s create path yet**: every issue created there
 * has `componentId: null` (004, architecture-graph, is not built — the same gap T018 already
 * documented), and `correlates()`'s own null-guard means calling this today would be a real
 * per-request database query that can never find a match — a genuine cost for zero behaviour,
 * not free completeness. Flagged in QUESTIONS.md: the natural call site is
 * `createOrAttachToWinner`'s "created: true" branch in `ingest-signal.ts`, once 004 resolves a
 * real `componentId`.
 */
export async function correlateIssue(
  repo: IssueRepository,
  context: TenantContext,
  issue: Issue,
): Promise<readonly IssueRelationship[]> {
  if (issue.componentId === null) return [];

  const candidates = await repo.findOpenCorrelationCandidates(
    scope(context, {
      componentId: issue.componentId,
      environment: issue.environment,
      excludeId: issue.id,
      since: new Date(issue.firstSeenAt.getTime() - CORRELATION_WINDOW_MS),
      until: new Date(issue.firstSeenAt.getTime() + CORRELATION_WINDOW_MS),
    }),
  );

  const relationships: IssueRelationship[] = [];
  for (const candidate of candidates) {
    if (!correlates(issue, candidate)) continue;
    const relationship = await repo.correlate(
      scope(context, { id: issue.id, otherId: candidate.id, rule: CORRELATION_RULE }),
    );
    if (relationship !== null) relationships.push(relationship);
  }
  return relationships;
}
