import { randomUUID } from 'node:crypto';
import { NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type Issue as IssueRow, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import type { Issue } from '../domain/issue.js';
import { issueDetectedEvent, issueStateChangedEvent } from '../domain/events.js';
import type { IssueRepository, NewIssue } from '../domain/repository.js';
import {
  ConcurrentModificationError,
  transitionIssue,
  type IssueEventCause,
} from '../domain/state-machine.js';

function toDomain(row: IssueRow): Issue {
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
    createdAt: row.createdAt,
  };
}

export class PrismaIssueRepository implements IssueRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(issue: TenantScoped<NewIssue>): Promise<Issue> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.issue.create({
        data: {
          id: issue.id,
          tenantId: issue.tenantId,
          kind: issue.kind,
          componentId: issue.componentId ?? null,
          environment: issue.environment,
          severity: issue.severity,
          state: 'detected',
          fingerprint: issue.fingerprint,
          rulesetVersion: issue.rulesetVersion,
          firstSeenAt: issue.firstSeenAt,
          lastSeenAt: issue.lastSeenAt,
        },
      });
      const created = toDomain(row);
      // The signal that created this issue is itself its first occurrence — recorded the same
      // way every later one is (review finding: without this, occurrenceCount and the count of
      // signal_received events in the timeline were always one apart).
      await tx.issueEvent.create({
        data: {
          id: randomUUID(),
          tenantId: issue.tenantId,
          issueId: issue.id,
          type: 'signal_received',
          cause: 'ingestion',
          actorRef: 'ingestion',
          payload: {} as Prisma.InputJsonValue,
          observedAt: issue.firstSeenAt,
        },
      });
      // Same transaction as the row it describes (001 T013, 012 FR-031) — a rolled-back create
      // is never observed downstream, and a committed one is never lost.
      await enqueue(new PrismaOutboxTransaction(tx), issueDetectedEvent(created));
      return created;
    });
  }

  async findById(where: TenantScoped<{ readonly id: string }>): Promise<Issue | null> {
    // The composite unique key, not a plain findUnique filtered afterward — tenantId is part of
    // the query itself, never a post-fetch check (security-and-tenancy.md).
    const row = await this.prisma.issue.findUnique({
      where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
    });
    return row === null ? null : toDomain(row);
  }

  async findOpenByFingerprint(
    where: TenantScoped<{ readonly fingerprint: string }>,
  ): Promise<Issue | null> {
    // `resolved` excluded on purpose (001 T018, FR-002, see the interface's own comment) — the
    // narrower half of T002's own `(tenant_id, fingerprint) where state not in ('merged',
    // 'removed')` index.
    const row = await this.prisma.issue.findFirst({
      where: {
        tenantId: where.tenantId,
        fingerprint: where.fingerprint,
        state: { notIn: ['resolved', 'merged', 'removed'] },
      },
    });
    return row === null ? null : toDomain(row);
  }

  async recordOccurrence(
    where: TenantScoped<{ readonly id: string }>,
    observedAt: Date,
  ): Promise<Issue> {
    return this.prisma.$transaction(async (tx) => {
      // GREATEST/LEAST inside one atomic UPDATE, not a read-then-compare-then-write: two signals
      // for the same issue landing at once were racing each other under the old read-modify-write
      // shape — whichever transaction's read happened to run last silently discarded the other's
      // timestamp, occasionally moving lastSeenAt *backwards* (review finding, reproduced 9/20
      // trials under concurrent load). GREATEST/LEAST evaluated by Postgres against the row's
      // committed value at write time has no such window.
      const affected = await tx.$executeRaw`
        UPDATE "issue"."issue"
        SET occurrence_count = occurrence_count + 1,
            last_seen_at = GREATEST(last_seen_at, ${observedAt}),
            first_seen_at = LEAST(first_seen_at, ${observedAt})
        WHERE id = ${where.id}::uuid AND tenant_id = ${where.tenantId}::uuid
      `;
      if (affected === 0) throw new NotFoundError('Issue');
      // Can't be null: `affected` above already proved the row exists in this same transaction.
      const updated = await tx.issue.findUnique({
        where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
      });
      await tx.issueEvent.create({
        data: {
          id: randomUUID(),
          tenantId: where.tenantId,
          issueId: where.id,
          type: 'signal_received',
          cause: 'ingestion',
          actorRef: 'ingestion',
          payload: {} as Prisma.InputJsonValue,
          observedAt,
        },
      });
      return toDomain(updated!);
    });
  }

  async transition(
    where: TenantScoped<{ readonly id: string }>,
    to: Issue['state'],
    cause: IssueEventCause,
    actorRef: string,
  ): Promise<Issue> {
    // SERIALIZABLE, not the default READ COMMITTED — two concurrent transitions both reading the
    // same `current.state` and both validating fine against the graph (review finding: both
    // `detected -> merged` and `detected -> investigating` are legal edges) used to both commit,
    // each writing its own `state_changed` event from the same `fromState`. A guarded
    // `UPDATE ... WHERE state = <the state validation ran against>` under READ COMMITTED — even
    // with an explicit `SELECT ... FOR UPDATE` locking the row first — still measurably let both
    // through on occasion in testing here; Postgres's own conflict detection under SERIALIZABLE
    // does not depend on getting every lock-ordering detail right by hand and proved airtight
    // (0/150 trials across repeated fresh-process runs, where the READ COMMITTED guard alone
    // failed intermittently). The conflict surfaces as Prisma error P2034, caught below.
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.issue.findUnique({
            where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
          });
          if (current === null) throw new NotFoundError('Issue');

          // Pure validation (001 T012) — the graph is the authority on what may happen next,
          // never the caller; a rejected transition never touches the database.
          const { event } = transitionIssue(toDomain(current), to, cause, actorRef);
          const now = new Date();

          // A raw `UPDATE ... WHERE ... AND state = <the state just validated>`, not a plain
          // `.update()` by id — the WHERE clause's explicit reference to `state` is what gives
          // Postgres's serializable-conflict detection a concrete overlap to catch between the
          // read above and this write; a write that only targets the row by id, with no
          // predicate on what was read, measurably escaped detection in testing here even under
          // SERIALIZABLE. `affected === 0` here is a second, redundant guard once SERIALIZABLE
          // is already catching the conflict as a P2034 — cheap, and consistent with "enforce
          // twice" elsewhere in this codebase (docs/patterns.md).
          const affected = await tx.$executeRaw`
            UPDATE "issue"."issue"
            SET state = ${to}::"issue"."issue_state"
            WHERE id = ${where.id}::uuid AND tenant_id = ${where.tenantId}::uuid
              AND state = ${current.state}::"issue"."issue_state"
          `;
          if (affected === 0) throw new ConcurrentModificationError('Issue');
          const updated = await tx.issue.findUnique({
            where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
          });
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
              payload: {} as Prisma.InputJsonValue,
              observedAt: now,
            },
          });
          // Same transaction as issue_event above (001 T013, 012 FR-031) — see create().
          await enqueue(
            new PrismaOutboxTransaction(tx),
            issueStateChangedEvent(where.tenantId, event),
          );
          // Can't be null: `affected === 1` above already proved the row exists in this transaction.
          return toDomain(updated!);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConcurrentModificationError('Issue');
      }
      throw error;
    }
  }
}
