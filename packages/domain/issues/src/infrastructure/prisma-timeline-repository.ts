import type { TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import type { TimelineEntry, TimelineRepository, TimelineSource } from '../domain/timeline.js';
import type { IssueEventCause } from '../domain/state-machine.js';

/** Raw `$queryRaw` rows carry the real column names (snake_case) — mapped here, once. */
interface RawTimelineRow {
  readonly source: TimelineSource;
  readonly id: string;
  readonly at: Date;
  readonly type: string;
  readonly cause: IssueEventCause;
  readonly actor_ref: string | null;
  readonly summary: string;
}

/**
 * Every arm filters `tenant_id` itself — the union is three separate tenant-scoped reads, not one
 * unscoped read post-filtered. `workflow_transition` has no `issue_id`: it reaches the issue
 * through `workflow_run`, joined on `(id, tenant_id)` so the join cannot cross tenants.
 *
 * `workflow_transition.cause` is `job | callback | timeout | human | policy`; the timeline's cause
 * set is the issue-event one, so the three machine causes read as `system`. Evidence has no cause
 * of its own and reads as `system` too, with the producing step as `actor_ref`.
 *
 * Summaries are assembled here from type/state columns and the producer's own `source_label`
 * — never from `excerpt` or `payload`, the columns that can hold customer text.
 * ORDER BY `(at, source, id)` is a total order, so identical timestamps cannot reorder between
 * renders (SC-005).
 */
export class PrismaTimelineRepository implements TimelineRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async forIssue(
    where: TenantScoped<{ readonly issueId: string }>,
  ): Promise<readonly TimelineEntry[]> {
    const rows = await this.prisma.$queryRaw<RawTimelineRow[]>`
      SELECT * FROM (
        SELECT 'issue_event' AS source, e.id::text AS id, e.observed_at AS at, e.type::text AS type,
               e.cause::text AS cause, e.actor_ref AS actor_ref,
               CASE WHEN e.from_state IS NOT NULL OR e.to_state IS NOT NULL
                    THEN e.type::text || ': ' || coalesce(e.from_state::text, '-') || ' -> ' || coalesce(e.to_state::text, '-')
                    ELSE e.type::text END AS summary
        FROM "issue"."issue_event" e
        WHERE e.tenant_id = ${where.tenantId}::uuid AND e.issue_id = ${where.issueId}::uuid
        UNION ALL
        SELECT 'workflow_transition', t.id::text, t.occurred_at, 'workflow_transition',
               CASE WHEN t.cause::text IN ('human', 'policy') THEN t.cause::text ELSE 'system' END,
               t.actor_ref,
               t.from_state || ' -> ' || t.to_state
        FROM "workflow"."workflow_transition" t
        JOIN "workflow"."workflow_run" r ON r.id = t.run_id AND r.tenant_id = t.tenant_id
        WHERE t.tenant_id = ${where.tenantId}::uuid AND r.issue_id = ${where.issueId}::uuid
        UNION ALL
        SELECT 'evidence', v.id::text, v.observed_at, 'evidence_recorded', 'system',
               v.produced_by_step,
               v.type::text || ' ' || v.source_label
        FROM "evidence"."evidence" v
        WHERE v.tenant_id = ${where.tenantId}::uuid AND v.issue_id = ${where.issueId}::uuid
      ) timeline
      ORDER BY at, source, id`;
    return rows.map((row) => ({
      source: row.source,
      id: row.id,
      at: row.at,
      type: row.type,
      cause: row.cause,
      actorRef: row.actor_ref,
      summary: row.summary,
      evidenceIds: row.source === 'evidence' ? [row.id] : [],
    }));
  }
}
