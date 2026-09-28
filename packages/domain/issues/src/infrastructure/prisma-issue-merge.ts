import { randomUUID } from 'node:crypto';
import { currentCorrelationId, NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import { issueMergedEvent, issueStateChangedEvent, issueUnmergedEvent } from '../domain/events.js';
import { checkMerge, MergeIntegrityError, UnmergeFingerprintTakenError } from '../domain/merge.js';
import type { MergeResult, UnmergeResult } from '../domain/merge-repository.js';
import { mergeTransition, unmergeTransition } from '../domain/state-machine.js';
import { toDomain } from './issue-row.js';
import { withConcurrencyTranslation } from './prisma-concurrency.js';

/** Only a human merges (see `IssueMergeRepository.merge`) — the `rule` on the row and the event's cause. */
const HUMAN = 'human';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Both operations publish events, and an event needs a correlation id. Checked before the
 * transaction is even opened — a missing scope is a programming error, and finding it out after
 * queueing for two row locks (or, worse, after the writes) is the slow way to learn it.
 */
function assertCorrelated(): void {
  if (currentCorrelationId() === undefined) {
    throw new Error(
      'merge and unmerge publish events: call them inside a correlated scope (withCorrelation)',
    );
  }
}

/**
 * Locks every named issue, in id order, and throws `NotFoundError` unless all of them exist under
 * this tenant. Everything after this reads the committed state of those rows and nobody can change
 * it until the transaction ends — `transition`, `recordOccurrence` and `markStale` all take the same
 * row lock to write. Without it, two merges (or a merge and a chain-forming merge) each validate
 * against the other's pre-commit state at READ COMMITTED and both write (see `markStale`, which
 * learned the same lesson). The fixed order is what stops two merges naming the same pair in
 * opposite directions from deadlocking. A malformed id is "not found", never a cast error that says
 * it was merely malformed (SC-004). `mergeIssue` lower-cases ids first: Postgres prints uuids lower-case, so
 * an upper-case spelling of the same id must not count as a second issue.
 */
async function lockIssues(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ids: readonly string[],
): Promise<void> {
  // Sorted here, and locked one at a time: the order is a fact of this code, not of whichever plan
  // Postgres picks for a single `ANY (...) ORDER BY ... FOR UPDATE` (which happened to return them
  // in index order, so the `ORDER BY` proved nothing when removed).
  const ordered = [...new Set(ids)].sort();
  if (!ordered.every((id) => UUID.test(id))) throw new NotFoundError('Issue');
  for (const id of ordered) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "issue"."issue"
      WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Issue');
  }
}

const byId = (tenantId: string, id: string) => ({ id_tenantId: { id, tenantId } });

/** `issue_tenant_id_fingerprint_open_key` (a partial index Prisma cannot declare) — see `create`. */
function isFingerprintConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) && target.includes('tenant_id') && target.includes('fingerprint');
}

/** The live `merged_into` row with `issueId` as its subject, if there is one. */
function liveMerge(tx: Prisma.TransactionClient, tenantId: string, issueId: string) {
  return tx.issueRelationship.findFirst({
    where: { tenantId, issueId, kind: 'merged_into', removedAt: null },
  });
}

/** See `IssueMergeRepository.merge` (001 T049). */
export async function mergeIssue(
  prisma: PrismaClient,
  where: TenantScoped<{ readonly id: string; readonly intoId: string }>,
  actorRef: string,
  reason: string,
): Promise<MergeResult> {
  assertCorrelated();
  const { tenantId } = where;
  const id = where.id.toLowerCase();
  const intoId = where.intoId.toLowerCase();
  return withConcurrencyTranslation(() =>
    prisma.$transaction(async (tx) => {
      await lockIssues(tx, tenantId, [id, intoId]);
      const source = await tx.issue.findUniqueOrThrow({ where: byId(tenantId, id) });
      const target = await tx.issue.findUniqueOrThrow({ where: byId(tenantId, intoId) });

      const live = await liveMerge(tx, tenantId, source.id);
      // Issues merged into this one, not counting any that have since been removed: a removed
      // issue keeps its row (the database allows `merged -> removed`) but is no longer an issue
      // that would be stranded, and counting it would pin this one as a merge source for good.
      const children = await tx.issueRelationship.count({
        where: {
          tenantId,
          otherIssueId: source.id,
          kind: 'merged_into',
          removedAt: null,
          issue: { state: { not: 'removed' } },
        },
      });
      const verdict = checkMerge(
        toDomain(source),
        toDomain(target),
        live?.otherIssueId ?? null,
        children > 0,
        reason,
      );
      if (verdict === 'already_merged')
        return { outcome: 'already_merged', issue: toDomain(source) };
      const { event } = mergeTransition(toDomain(source), HUMAN, actorRef);
      // Built before the first write: a missing correlation scope must not be discovered halfway.
      const stateChanged = issueStateChangedEvent(tenantId, event);
      const merged = issueMergedEvent(tenantId, source.id, target.id, reason);

      // The row, the state, the event and the outbox in one transaction: a merged issue with no
      // row (or a row on an unmerged one) is not a state this method can leave behind, and the
      // database's own deferred check refuses to commit one written any other way.
      const relationshipId = randomUUID();
      await tx.issueRelationship.create({
        data: {
          id: relationshipId,
          tenantId,
          issueId: source.id,
          otherIssueId: target.id,
          kind: 'merged_into',
          rule: HUMAN,
        },
      });
      const updated = await tx.issue.update({
        where: byId(tenantId, source.id),
        data: { state: 'merged' },
      });
      // `from_state` is where the unmerge goes back to; `relationshipId` ties this event to the row
      // it created, so a later merge/unmerge cycle can never be mistaken for this one. The event is
      // append-only in the database (R-03), so what the unmerge relies on cannot be edited away.
      await tx.issueEvent.create({
        data: {
          id: randomUUID(),
          tenantId,
          issueId: source.id,
          type: 'merged',
          fromState: event.fromState,
          toState: event.toState,
          cause: event.cause,
          actorRef,
          payload: { intoIssueId: target.id, relationshipId, reason },
          observedAt: new Date(),
        },
      });
      const outbox = new PrismaOutboxTransaction(tx);
      await enqueue(outbox, stateChanged);
      await enqueue(outbox, merged);
      return { outcome: 'merged', issue: toDomain(updated) };
    }),
  );
}

/** See `IssueMergeRepository.unmerge` (001 T050). */
export async function unmergeIssue(
  prisma: PrismaClient,
  where: TenantScoped<{ readonly id: string }>,
  actorRef: string,
): Promise<UnmergeResult> {
  assertCorrelated();
  const { tenantId } = where;
  // One id needs no case folding: Postgres reads either spelling of a uuid as the same value.
  return withConcurrencyTranslation(() =>
    prisma.$transaction(async (tx) => {
      await lockIssues(tx, tenantId, [where.id]);
      const source = await tx.issue.findUniqueOrThrow({ where: byId(tenantId, where.id) });
      const live = await liveMerge(tx, tenantId, source.id);
      if (live === null) {
        // Already unmerged (or never merged): nothing to undo. `merged` with no row is the one
        // shape that cannot exist — the database refuses it — so seeing it means the guarantee broke.
        if (source.state === 'merged') {
          throw new MergeIntegrityError('merged_without_relationship', source.id);
        }
        return { outcome: 'not_merged', issue: toDomain(source) };
      }

      // The event tied to *this* row. Not "the latest merged event": an older cycle's event names a
      // different row, and restoring from it would be a guess that happens to look right.
      const mergeEvent = await tx.issueEvent.findFirst({
        where: {
          tenantId,
          issueId: source.id,
          type: 'merged',
          payload: { path: ['relationshipId'], equals: live.id },
        },
      });
      if (mergeEvent?.fromState == null) {
        throw new MergeIntegrityError('merge_record_missing', source.id);
      }
      const { event } = unmergeTransition(toDomain(source), mergeEvent.fromState, HUMAN, actorRef);
      const stateChanged = issueStateChangedEvent(tenantId, event);
      const unmerged = issueUnmergedEvent(tenantId, source.id, live.otherIssueId);

      const withdrawn = await tx.issueRelationship.updateMany({
        where: { id: live.id, tenantId, removedAt: null },
        data: { removedAt: new Date() },
      });
      if (withdrawn.count !== 1) throw new MergeIntegrityError('relationship_vanished', source.id);
      let updated;
      try {
        updated = await tx.issue.update({
          where: byId(tenantId, source.id),
          data: { state: event.toState },
        });
      } catch (error) {
        // The restored state is an open one and another open issue has the fingerprint (`merge`
        // freed it). Nothing was written; a person resolves one of the two and tries again.
        if (isFingerprintConflict(error)) {
          throw new UnmergeFingerprintTakenError(source.id, source.fingerprint, event.toState);
        }
        throw error;
      }
      await tx.issueEvent.create({
        data: {
          id: randomUUID(),
          tenantId,
          issueId: source.id,
          type: 'unmerged',
          fromState: event.fromState,
          toState: event.toState,
          cause: event.cause,
          actorRef,
          payload: { intoIssueId: live.otherIssueId, relationshipId: live.id },
          observedAt: new Date(),
        },
      });
      const outbox = new PrismaOutboxTransaction(tx);
      await enqueue(outbox, stateChanged);
      await enqueue(outbox, unmerged);
      return { outcome: 'unmerged', issue: toDomain(updated) };
    }),
  );
}
