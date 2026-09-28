import { randomUUID } from 'node:crypto';
import { NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import type { Issue, IssueRelationship } from '../domain/issue.js';
import { toDomain } from './issue-row.js';
import { mergeIssue, unmergeIssue } from './prisma-issue-merge.js';
import { correlate as correlateIssues } from './prisma-issue-relationships.js';
import { findStaleCandidates, markStale } from './prisma-issue-staleness.js';
import { planTransitionEffects, recordTransitionAudit } from './prisma-transition-effects.js';
import {
  issueDetectedEvent,
  issueResolvedEvent,
  issueStateChangedEvent,
} from '../domain/events.js';
import type {
  IssueMergeRepository,
  MergeResult,
  UnmergeResult,
} from '../domain/merge-repository.js';
import {
  FingerprintAlreadyOpenError,
  type IssueRepository,
  type NewIssue,
  type StaleCandidate,
  type TransitionAudit,
} from '../domain/repository.js';
import {
  ConcurrentModificationError,
  transitionIssue,
  type IssueEventCause,
} from '../domain/state-machine.js';

/** The one rule name `create`'s `recurrenceOf` path ever writes (001 T022) — see its call site. */
const RECURRENCE_RULE = 'reopen_window_exceeded';

/**
 * `issue_tenant_id_fingerprint_open_key` (migration 20260927060000) isn't declared in
 * `schema.prisma` — Prisma can't express a partial unique index — so its P2002 reports the raw
 * database column names in `meta.target` (confirmed empirically: `["tenant_id", "fingerprint"]`,
 * snake_case, not this repository's own `tenantId`/`fingerprint` field names), not a constraint
 * name string the way a schema-declared `@@unique` would.
 */
function isTenantFingerprintTarget(meta: unknown): boolean {
  const target = (meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) && target.includes('tenant_id') && target.includes('fingerprint');
}

export class PrismaIssueRepository implements IssueRepository, IssueMergeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(issue: TenantScoped<NewIssue>): Promise<Issue> {
    try {
      return await this.createInTransaction(issue);
    } catch (error) {
      // 001 T026 review finding: `issue_tenant_id_fingerprint_open_key` (migration
      // 20260927060000) is the actual safety net for the race this translates — see
      // `FingerprintAlreadyOpenError`'s own doc comment for why the caller, not this method,
      // decides what to do about it.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        isTenantFingerprintTarget(error.meta)
      ) {
        throw new FingerprintAlreadyOpenError(issue.fingerprint);
      }
      throw error;
    }
  }

  private async createInTransaction(issue: TenantScoped<NewIssue>): Promise<Issue> {
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
      if (issue.recurrenceOf !== undefined) {
        // Same transaction as the issue row (001 T022, FR-005, FR-020): a recurrence with no
        // relationship row is exactly the "prose guarantee, no mechanism" shape this repository
        // exists to make impossible. `RECURRENCE_RULE` is this path's only rule — the sole
        // authority for how a `recurrence_of` link created here explains itself.
        await tx.issueRelationship.create({
          data: {
            id: randomUUID(),
            tenantId: issue.tenantId,
            issueId: issue.id,
            otherIssueId: issue.recurrenceOf,
            kind: 'recurrence_of',
            rule: RECURRENCE_RULE,
          },
        });
        await tx.issueEvent.create({
          data: {
            id: randomUUID(),
            tenantId: issue.tenantId,
            issueId: issue.id,
            type: 'related',
            cause: 'ingestion',
            actorRef: 'ingestion',
            payload: {
              kind: 'recurrence_of',
              otherIssueId: issue.recurrenceOf,
              rule: RECURRENCE_RULE,
            } as Prisma.InputJsonValue,
            observedAt: issue.firstSeenAt,
          },
        });
      }
      // Same transaction as the row it describes (001 T013, 012 FR-031) — a rolled-back create
      // is never observed downstream, and a committed one is never lost.
      await enqueue(new PrismaOutboxTransaction(tx), issueDetectedEvent(created));
      return created;
    });
  }

  async findById(where: TenantScoped<{ readonly id: string }>): Promise<Issue | null> {
    // The composite unique key, not a plain findUnique filtered afterward — tenantId is part of
    // the query itself, never a post-fetch check (security-and-tenancy.md).
    try {
      const row = await this.prisma.issue.findUnique({
        where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
      });
      return row === null ? null : toDomain(row);
    } catch (error) {
      // A malformed (non-UUID) id fails Postgres's own column cast (P2023) before the query ever
      // runs — indistinguishable from "does not exist" for a caller, and must stay that way
      // (SC-004: never a 500 that reveals the id was merely malformed rather than absent).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2023') {
        return null;
      }
      throw error;
    }
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

  async findMostRecentlyResolvedByFingerprint(
    where: TenantScoped<{ readonly fingerprint: string }>,
  ): Promise<Issue | null> {
    // `state = 'resolved'` is a subset of T002's `where state not in ('merged', 'removed')`
    // partial index, so this query still uses it — no second index needed. Ordered by
    // `resolvedAt` descending: a recurrence chain can leave more than one resolved issue sharing
    // this fingerprint, and only the most recent resolution is the one FR-005's window measures.
    const row = await this.prisma.issue.findFirst({
      where: { tenantId: where.tenantId, fingerprint: where.fingerprint, state: 'resolved' },
      orderBy: { resolvedAt: 'desc' },
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
    reason?: string,
    audit?: TransitionAudit,
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
    // failed intermittently). The conflict surfaces as Postgres SQLSTATE 40001, caught below —
    // **root cause of this test's long-documented residual flakiness** (QUESTIONS.md "001
    // review — transition() concurrency test residual flakiness"): confirmed by instrumenting a
    // 20-trial probe that this raw `$executeRaw` UPDATE's own serialization failure surfaces as
    // Prisma error **P2010** ("raw query failed"), wrapping the real Postgres code in `error.meta`
    // — never as P2034, which Prisma only assigns to failures of its own generated queries. The
    // original catch below checked only for P2034, so this exact conflict — the one the whole
    // SERIALIZABLE design exists to catch — was silently rethrown as an unhandled
    // `PrismaClientKnownRequestError` instead of the intended `ConcurrentModificationError`,
    // which is exactly the "unexpected error type" this test's assertion had been failing with.
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
          const effects = planTransitionEffects(to, cause, reason, audit);
          const now = new Date();

          // `resolved_at` (001 T022, FR-005): set the moment this transition lands on `resolved`,
          // cleared the moment it leaves it (the `resolved -> investigating` reopen edge) —
          // computed here, not left to a trigger, since both "to" and "from" are already known.
          const resolvedAt =
            to === 'resolved' ? now : current.state === 'resolved' ? null : current.resolvedAt;

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
            SET state = ${to}::"issue"."issue_state",
                resolved_at = ${resolvedAt}::timestamptz
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
              payload: (reason === undefined ? {} : { reason }) as Prisma.InputJsonValue,
              observedAt: now,
            },
          });
          if (effects.audit !== undefined) {
            await recordTransitionAudit(
              tx,
              { tenantId: where.tenantId, issueId: where.id, actorRef },
              effects.audit,
            );
          }
          // Same transaction as issue_event above (001 T013, 012 FR-031) — see create().
          await enqueue(
            new PrismaOutboxTransaction(tx),
            issueStateChangedEvent(where.tenantId, event),
          );
          if (effects.resolution !== undefined) {
            // The resolution came from the cause (`planTransitionEffects`), never from `to`
            // alone: today only a human close has one (`self_resolved`, no evidence, C-09).
            await enqueue(
              new PrismaOutboxTransaction(tx),
              issueResolvedEvent(where.tenantId, where.id, effects.resolution),
            );
          }
          // Can't be null: `affected === 1` above already proved the row exists in this transaction.
          return toDomain(updated!);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // P2034: a serialization failure Prisma detected in one of its own generated queries.
        // P2010 wrapping Postgres SQLSTATE 40001/40P01: the same failure, but raised by the raw
        // `$executeRaw` UPDATE above, which Prisma does not fold into P2034 (see the comment at
        // this method's top). Both mean the same thing: reread and retry.
        const meta = error.meta as { code?: string } | undefined;
        const isSerializationFailure =
          error.code === 'P2034' ||
          (error.code === 'P2010' && (meta?.code === '40001' || meta?.code === '40P01'));
        if (isSerializationFailure) {
          throw new ConcurrentModificationError('Issue');
        }
      }
      throw error;
    }
  }

  async findOpenCorrelationCandidates(
    where: TenantScoped<{
      readonly componentId: string;
      readonly environment: string;
      readonly excludeId: string;
      readonly since: Date;
      readonly until: Date;
    }>,
  ): Promise<readonly Issue[]> {
    const rows = await this.prisma.issue.findMany({
      where: {
        tenantId: where.tenantId,
        componentId: where.componentId,
        environment: where.environment,
        id: { not: where.excludeId },
        // "Open" means the same thing everywhere in this repository (review finding: this used
        // to only exclude merged/removed, letting a resolved issue — closed, done, no longer under
        // investigation — count as a live correlation candidate) — `findOpenByFingerprint`'s own
        // exclusion set is the one authority for what "open" means here (FR-002).
        state: { notIn: ['resolved', 'merged', 'removed'] },
        firstSeenAt: { gte: where.since, lte: where.until },
      },
    });
    return rows.map(toDomain);
  }

  /** See `correlate` in `prisma-issue-relationships.ts` (001 T039). */
  correlate(
    where: TenantScoped<{ readonly id: string; readonly otherId: string; readonly rule: string }>,
  ): Promise<IssueRelationship | null> {
    return correlateIssues(this.prisma, where);
  }

  /** See `mergeIssue` in `prisma-issue-merge.ts` (001 T049). */
  merge(
    where: TenantScoped<{ readonly id: string; readonly intoId: string }>,
    actorRef: string,
    reason: string,
  ): Promise<MergeResult> {
    return mergeIssue(this.prisma, where, actorRef, reason);
  }

  /** See `unmergeIssue` in `prisma-issue-merge.ts` (001 T050). */
  unmerge(where: TenantScoped<{ readonly id: string }>, actorRef: string): Promise<UnmergeResult> {
    return unmergeIssue(this.prisma, where, actorRef);
  }

  async list(
    where: TenantScoped<{
      readonly state?: Issue['state'];
      readonly componentId?: string;
      readonly since?: Date;
    }>,
  ): Promise<readonly Issue[]> {
    const rows = await this.prisma.issue.findMany({
      where: {
        tenantId: where.tenantId,
        ...(where.state !== undefined ? { state: where.state } : {}),
        ...(where.componentId !== undefined ? { componentId: where.componentId } : {}),
        ...(where.since !== undefined ? { firstSeenAt: { gte: where.since } } : {}),
      },
      orderBy: { firstSeenAt: 'desc' },
    });
    return rows.map(toDomain);
  }

  async findRelationships(
    where: TenantScoped<{ readonly id: string }>,
  ): Promise<readonly IssueRelationship[]> {
    const rows = await this.prisma.issueRelationship.findMany({
      where: {
        tenantId: where.tenantId,
        removedAt: null,
        OR: [{ issueId: where.id }, { otherIssueId: where.id }],
      },
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      issueId: row.issueId,
      otherIssueId: row.otherIssueId,
      kind: row.kind,
      rule: row.rule,
      createdAt: row.createdAt,
    }));
  }

  /** See `findStaleCandidates` in `prisma-issue-staleness.ts` (001 T051). */
  findStaleCandidates(
    where: TenantScoped<{ readonly idleBefore: Date }>,
  ): Promise<readonly StaleCandidate[]> {
    return findStaleCandidates(this.prisma, where);
  }

  /** See `markStale` in `prisma-issue-staleness.ts` (001 T051). */
  markStale(
    where: TenantScoped<{
      readonly id: string;
      readonly at: Date;
      readonly lastProgressAt: Date;
    }>,
  ): Promise<Issue> {
    return markStale(this.prisma, where);
  }
}
