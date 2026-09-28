import { randomUUID } from 'node:crypto';
import type { TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import type { IssueRelationship } from '../domain/issue.js';
import { issueRelatedEvent } from '../domain/events.js';

/**
 * `issue_relationship_tenant_id_issue_id_other_kind_key` (schema-declared, since it has no
 * `WHERE` clause `@@unique` can't express — T002's own design) — confirmed empirically the same
 * way: snake_case column names in `meta.target`, not this repository's camelCase field names.
 */
function isIssueRelationshipTarget(meta: unknown): boolean {
  const target = (meta as { target?: unknown } | undefined)?.target;
  return (
    Array.isArray(target) &&
    target.includes('issue_id') &&
    target.includes('other_issue_id') &&
    target.includes('kind')
  );
}

export async function correlate(
  prisma: PrismaClient,
  where: TenantScoped<{ readonly id: string; readonly otherId: string; readonly rule: string }>,
): Promise<IssueRelationship | null> {
  // `related` is symmetric (either issue may be the subject) but the unique index backing
  // idempotency, `issue_relationship_tenant_id_issue_id_other_kind_key`, is directional —
  // review finding: without a canonical order, issue A correlating against B and B correlating
  // against A (both real, concurrent orderings once two issues discover each other) each pass
  // the index's own uniqueness check and insert a second row for the same pair. Sorting by id
  // here, once, is the one place this needs deciding — every caller gets real idempotency
  // regardless of which side happened to call first.
  const [issueId, otherIssueId] =
    where.id < where.otherId ? [where.id, where.otherId] : [where.otherId, where.id];
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.issueRelationship.create({
        data: {
          id: randomUUID(),
          tenantId: where.tenantId,
          issueId,
          otherIssueId,
          kind: 'related',
          rule: where.rule,
        },
      });
      const relationship: IssueRelationship = {
        id: row.id,
        tenantId: row.tenantId,
        issueId: row.issueId,
        otherIssueId: row.otherIssueId,
        kind: row.kind,
        rule: row.rule,
        createdAt: row.createdAt,
      };
      await tx.issueEvent.create({
        data: {
          id: randomUUID(),
          tenantId: where.tenantId,
          issueId: where.id,
          type: 'related',
          cause: 'system',
          actorRef: 'correlation',
          payload: {
            kind: 'related',
            otherIssueId: where.otherId,
            rule: where.rule,
          } as Prisma.InputJsonValue,
          observedAt: row.createdAt,
        },
      });
      // Same transaction as the row it describes (001 T013, 012 FR-031).
      await enqueue(
        new PrismaOutboxTransaction(tx),
        issueRelatedEvent(where.tenantId, relationship),
      );
      return relationship;
    });
  } catch (error) {
    // Idempotent (001 T039): the same `(issueId, otherIssueId, kind)` pair correlating a
    // second time is a no-op, not an error — matching `create`'s own `FingerprintAlreadyOpenError`
    // precedent for "someone/something already recorded this fact".
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      isIssueRelationshipTarget(error.meta)
    ) {
      return null;
    }
    throw error;
  }
}
