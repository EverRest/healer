import { randomUUID } from 'node:crypto';
import { NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type Issue as IssueRow, type PrismaClient } from '@healer/prisma-client';
import type { Issue } from '../domain/issue.js';
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
    const row = await this.prisma.issue.create({
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
    return toDomain(row);
  }

  async findById(where: TenantScoped<{ readonly id: string }>): Promise<Issue | null> {
    // The composite unique key, not a plain findUnique filtered afterward — tenantId is part of
    // the query itself, never a post-fetch check (security-and-tenancy.md).
    const row = await this.prisma.issue.findUnique({
      where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
    });
    return row === null ? null : toDomain(row);
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
      return toDomain(updated);
    });
  }
}
