import { randomUUID } from 'node:crypto';
import { NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type Issue as IssueRow, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import type { Issue } from '../domain/issue.js';
import { issueDetectedEvent, issueStateChangedEvent } from '../domain/events.js';
import type { IssueRepository, NewIssue } from '../domain/repository.js';
import { transitionIssue, type IssueEventCause } from '../domain/state-machine.js';

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
      const current = await tx.issue.findUnique({
        where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
      });
      if (current === null) throw new NotFoundError('Issue');

      // Never backwards (R-10): an out-of-order signal must not make lastSeenAt look stale.
      const lastSeenAt = observedAt > current.lastSeenAt ? observedAt : current.lastSeenAt;
      const updated = await tx.issue.update({
        where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
        data: { occurrenceCount: { increment: 1 }, lastSeenAt },
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
      return toDomain(updated);
    });
  }

  async transition(
    where: TenantScoped<{ readonly id: string }>,
    to: Issue['state'],
    cause: IssueEventCause,
    actorRef: string,
  ): Promise<Issue> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.issue.findUnique({
        where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
      });
      if (current === null) throw new NotFoundError('Issue');

      // Pure validation first (001 T012) — the graph is the authority on what may happen next,
      // never the caller; a rejected transition never touches the database.
      const { event } = transitionIssue(toDomain(current), to, cause, actorRef);
      const now = new Date();

      const updated = await tx.issue.update({
        where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
        data: { state: to },
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
      await enqueue(new PrismaOutboxTransaction(tx), issueStateChangedEvent(where.tenantId, event));
      return toDomain(updated);
    });
  }
}
