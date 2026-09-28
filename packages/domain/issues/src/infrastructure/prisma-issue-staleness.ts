import { randomUUID } from 'node:crypto';
import { NotFoundError, type TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import type { Issue } from '../domain/issue.js';
import { issueStaleEvent } from '../domain/events.js';
import type { StaleCandidate } from '../domain/repository.js';
import { ConcurrentModificationError, transitionIssue } from '../domain/state-machine.js';
import { toDomain } from './issue-row.js';

/** `actor_ref` of every transition the staleness sweep makes (001 T051). */
const STALENESS_SWEEP = 'staleness-sweep';

/**
 * "Progress" is the system's own clock, not the source's: the latest `received_at` across the
 * issue's `issue_event` rows, or `created_at` if it has none. `last_seen_at` is the source clock
 * (R-10) and never moves backwards, so a delayed signal from last month would leave it untouched
 * — yet it is a signal that just arrived, and the issue it landed on is not idle. Live states
 * only: `resolved`, `merged`, `removed` and already-`stale` are history (R-11), which is also
 * what makes a second sweep find nothing.
 *
 * ponytail: one lateral `max()` per live issue and no LIMIT, inside the maintenance queue's
 * 10-minute budget — batch it, and add a denormalised `last_progress_at` column, if a tenant's
 * live issues ever outgrow that. An overrun is survivable: the retry re-reads, skips whatever the
 * first run already marked, and carries on.
 */
export async function findStaleCandidates(
  prisma: PrismaClient,
  where: TenantScoped<{ readonly idleBefore: Date }>,
): Promise<readonly StaleCandidate[]> {
  const rows = await prisma.$queryRaw<{ id: string; last_progress_at: Date }[]>`
      SELECT i.id, GREATEST(i.created_at, coalesce(p.last_received, i.created_at)) AS last_progress_at
      FROM "issue"."issue" i
      LEFT JOIN LATERAL (
        SELECT max(e.received_at) AS last_received FROM "issue"."issue_event" e
        WHERE e.tenant_id = i.tenant_id AND e.issue_id = i.id
      ) p ON true
      WHERE i.tenant_id = ${where.tenantId}::uuid
        AND i.state NOT IN ('resolved', 'merged', 'removed', 'stale')
        AND GREATEST(i.created_at, coalesce(p.last_received, i.created_at)) < ${where.idleBefore}::timestamptz
      ORDER BY last_progress_at, i.id`;
  return rows.map((row) => ({ id: row.id, lastProgressAt: row.last_progress_at }));
}

/**
 * Validated by the same state graph as `transition` (`X -> stale` must be a declared edge), so
 * this cannot mark an issue the graph forbids.
 *
 * **Locks the row first** (`FOR UPDATE`), then reads, then measures progress. `recordOccurrence`
 * and `transition` both take that same row lock before they write their `issue_event`, so a
 * signal that is mid-commit makes this wait, and the progress check afterwards sees it. Without
 * the lock the check ran against a snapshot that could not see the uncommitted event, and the
 * `UPDATE` — which only re-tests `state` after the lock wait — marked a live issue stale over the
 * top of a committed signal. Anything received since the sweep's read throws
 * `ConcurrentModificationError`, which the sweep treats as "not stale after all", not a failure.
 */
export async function markStale(
  prisma: PrismaClient,
  where: TenantScoped<{
    readonly id: string;
    readonly at: Date;
    readonly lastProgressAt: Date;
  }>,
): Promise<Issue> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "issue"."issue"
      WHERE id = ${where.id}::uuid AND tenant_id = ${where.tenantId}::uuid
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Issue');
    // Read after the lock, so this is the row as of whatever committed while we waited.
    const current = await tx.issue.findUniqueOrThrow({
      where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
    });
    const { event } = transitionIssue(toDomain(current), 'stale', 'system', STALENESS_SWEEP);

    // Compared in SQL, truncated to milliseconds: `lastProgressAt` went through a JS `Date`
    // (millisecond precision) and `received_at` is microseconds, so comparing them in JS would
    // read every issue as having progressed since.
    const [progress] = await tx.$queryRaw<{ moved: boolean }[]>`
      SELECT coalesce(date_trunc('milliseconds', max(received_at)) > ${where.lastProgressAt}::timestamptz, false) AS moved
      FROM "issue"."issue_event"
      WHERE tenant_id = ${where.tenantId}::uuid AND issue_id = ${where.id}::uuid`;
    // An aggregate always returns one row; a missing one is a bug, and reading it as "did not
    // move" would mark the issue stale.
    if (progress === undefined) throw new Error('progress check returned no row');
    if (progress.moved) throw new ConcurrentModificationError('Issue');

    const affected = await tx.$executeRaw`
      UPDATE "issue"."issue"
      SET state = 'stale'::"issue"."issue_state", stale_at = ${where.at}::timestamptz
      WHERE id = ${where.id}::uuid AND tenant_id = ${where.tenantId}::uuid
        AND state = ${current.state}::"issue"."issue_state"`;
    if (affected === 0) throw new ConcurrentModificationError('Issue');

    await tx.issueEvent.create({
      data: {
        id: randomUUID(),
        tenantId: where.tenantId,
        issueId: where.id,
        type: 'state_changed',
        fromState: event.fromState,
        toState: event.toState,
        cause: event.cause,
        actorRef: event.actorRef,
        payload: { lastProgressAt: where.lastProgressAt.toISOString() },
        observedAt: where.at,
      },
    });
    await enqueue(
      new PrismaOutboxTransaction(tx),
      issueStaleEvent(where.tenantId, where.id, where.lastProgressAt),
    );
    return toDomain(
      await tx.issue.findUniqueOrThrow({
        where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
      }),
    );
  });
}
