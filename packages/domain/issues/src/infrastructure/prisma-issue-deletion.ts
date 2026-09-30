import { randomUUID } from 'node:crypto';
import { currentCorrelationId, NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, withPrivilegedWrite, type PrismaClient } from '@healer/prisma-client';
import { CLAIM_TIMEOUT_SQL, enqueue, PrismaOutboxTransaction } from '@healer/events';
import {
  checkDeletionRequest,
  DeletionIntegrityError,
  DeletionTimedOutError,
  IssueEventsInFlightError,
  IssueHasMergedChildrenError,
  IssueMergedIntoAnotherError,
  type DeleteIssueResult,
  type DeletionTombstone,
  type IssueDeletionRepository,
} from '../domain/deletion.js';
import { issueDeletedEvent } from '../domain/events.js';
import { translateConcurrencyError } from './prisma-concurrency.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every column in the database that names an issue, as `schema.table.column` — the closed list of
 * what a deletion must reach by `issue_id`. `issue-deletion.e2e.test.ts` compares it with
 * `information_schema`, so a feature that adds a table with an `issue_id` (006's diagnosis, 010's
 * remediation) fails that test until this file handles it: a deletion that silently skips a new
 * table would keep customer content and say it had not (the guarantee's reader is that test).
 * What it cannot see, because no column is called `issue_id`, is handled by name below:
 * `evidence_link` (through its evidence), `audit_entry.target_id` and `outbox.subject_id`.
 */
export const ISSUE_ID_COLUMNS = [
  'agent.agent_run.issue_id',
  'evidence.evidence.issue_id',
  'issue.issue_event.issue_id',
  'issue.issue_relationship.issue_id',
  'issue.issue_relationship.other_issue_id',
  'policy.policy_decision.issue_id',
  'workflow.workflow_run.issue_id',
] as const;

/**
 * The action that lets the append-only triggers step aside covers every statement of the
 * transaction (`withPrivilegedWrite`), so the callback below is nothing but the locks, the checks
 * that decide whether to proceed, the deletes and the tombstone.
 *
 * ponytail: R-03 says the privileged path is itself audited. Here the audit is the tombstone (it
 * lives in the `audit` schema, is immutable, and says who, when and why); no `audit_entry` is
 * written, because one targeting the deleted id would make an audit read for that id return
 * something, and the action key (`issue.delete`) would be one more unregistered placeholder until
 * 002's list exists (QUESTIONS.md "001 T053").
 */
/**
 * Bounds of one deletion. Waiting for a lock is bounded by `lockTimeoutMs`, not by Prisma's own
 * transaction timeout: that one only fires once the blocked statement returns, so on its own it never
 * cuts a wait short. The whole transaction is bounded by `timeoutMs` for a big issue. Both surface as
 * `DeletionTimedOutError`, not as "concurrent, retry" — a retry of an issue too big for the bound fails
 * identically forever. Generous on purpose; an erasure request is not latency-sensitive.
 */
export interface IssueDeletionOptions {
  readonly lockTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly maxWaitMs?: number;
}

export class PrismaIssueDeletionRepository implements IssueDeletionRepository {
  private readonly lockTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly maxWaitMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    options: IssueDeletionOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
  }

  async findTombstone(
    where: TenantScoped<{ readonly id: string }>,
  ): Promise<DeletionTombstone | null> {
    if (!UUID.test(where.id)) return null;
    const row = await this.prisma.deletionTombstone.findFirst({
      where: { tenantId: where.tenantId, targetType: 'issue', targetId: where.id.toLowerCase() },
    });
    return row === null ? null : toTombstone(row);
  }

  async deleteIssue(
    where: TenantScoped<{ readonly id: string }>,
    requestedBy: string,
    reason: string,
  ): Promise<DeleteIssueResult> {
    const { tenantId } = where;
    // The one enforcement point for the text (the command checks too, but a direct call must not
    // reach the database `CHECK`s): before anything is locked.
    checkDeletionRequest(requestedBy, reason);
    // A malformed id is "not found", never a cast error that says it was merely malformed (SC-004).
    if (!UUID.test(where.id)) throw new NotFoundError('Issue');
    const id = where.id.toLowerCase();
    // The event needs a correlation id: find that out before queueing for a row lock.
    if (currentCorrelationId() === undefined) {
      throw new Error('deleteIssue publishes an event: call it inside a correlated scope');
    }
    try {
      return await withPrivilegedWrite(
        this.prisma,
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(this.lockTimeoutMs)}, true)`;
          // The issue row first, `FOR UPDATE`: every writer of an issue's rows (a signal, a
          // transition, a merge, evidence, a relationship) takes this lock or a foreign-key share of
          // it before writing, so what is read below is final until this transaction ends, and a
          // second deletion waits here and then finds the row gone.
          const locked = await tx.$queryRaw<{ state: string }[]>`
            SELECT state::text AS state FROM "issue"."issue"
            WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
          if (locked.length === 0) {
            const existing = await tx.deletionTombstone.findFirst({
              where: { tenantId, targetType: 'issue', targetId: id },
            });
            if (existing === null) throw new NotFoundError('Issue');
            return { outcome: 'already_deleted', tombstone: toTombstone(existing) };
          }
          await assertNoMergedChildren(tx, tenantId, id);
          if (locked[0]!.state === 'merged') await assertNotMergedIntoAnother(tx, tenantId, id);
          await assertNoEventInFlight(tx, tenantId, id);
          // Evidence next: a link (or a retention purge) racing this deletion holds a share of the
          // evidence row, so locking them makes it finish first or wait until we are done, rather
          // than fail our `DELETE` on the foreign key halfway through.
          await tx.$queryRaw`
            SELECT id FROM "evidence"."evidence"
            WHERE tenant_id = ${tenantId}::uuid AND issue_id = ${id}::uuid FOR UPDATE`;

          await deleteDerivedRows(tx, tenantId, id);
          // Exactly one row: a trigger that swallowed the delete must not leave a tombstone for an
          // issue that still exists.
          const removed = await tx.$executeRaw`
            DELETE FROM "issue"."issue" WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`;
          if (removed !== 1) throw new DeletionIntegrityError('issue_not_deleted', id);

          const tombstone = await createTombstone(tx, { tenantId, id, requestedBy, reason });
          // After the outbox delete above, so the one row about this issue that survives is this one.
          await enqueue(
            new PrismaOutboxTransaction(tx),
            issueDeletedEvent(tenantId, id, tombstone.id),
          );
          return { outcome: 'deleted', tombstone: toTombstone(tombstone) };
        },
        { maxWait: this.maxWaitMs, timeout: this.timeoutMs },
      );
    } catch (error) {
      throw translateDeletionError(error, id);
    }
  }
}

/**
 * Prisma's own `P2028` (transaction not started or expired) and Postgres's `lock_timeout`
 * (SQLSTATE 55P03, which a raw query reports as `P2010` and a typed one as an unclassified error)
 * are both "took too long". Everything else is the shared concurrency mapping.
 */
function translateDeletionError(error: unknown, issueId: string): unknown {
  const raw = error as { code?: string; meta?: { code?: string }; message?: string };
  const isTimeout =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? raw.code === 'P2028' || raw.meta?.code === '55P03'
      : error instanceof Prisma.PrismaClientUnknownRequestError &&
        /code: "55P03"/.test(raw.message ?? '');
  return isTimeout ? new DeletionTimedOutError(issueId) : translateConcurrencyError(error);
}

/** A tombstone that already exists for a row that is still here: something wrote around us. */
async function createTombstone(
  tx: Prisma.TransactionClient,
  t: { tenantId: string; id: string; requestedBy: string; reason: string },
) {
  try {
    return await tx.deletionTombstone.create({
      data: {
        id: randomUUID(),
        tenantId: t.tenantId,
        targetType: 'issue',
        targetId: t.id,
        requestedBy: t.requestedBy,
        reason: t.reason,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new DeletionIntegrityError('tombstone_for_live_issue', t.id);
    }
    throw error;
  }
}

/**
 * The issue is `merged` into a survivor. Nothing ties an evidence link to the issue whose conclusion
 * made it, and after a merge the survivor may legitimately cite this issue's evidence (FR-009):
 * deleting the links would silently unsupport it. Refused while the merge stands. An issue that was
 * merged and then `removed` is not refused — `unmerge` refuses it too, so refusing here would leave it
 * undeletable (QUESTIONS.md "001 T053").
 */
async function assertNotMergedIntoAnother(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<void> {
  const live = await tx.issueRelationship.findFirst({
    where: { tenantId, issueId: id, kind: 'merged_into', removedAt: null },
  });
  if (live !== null) throw new IssueMergedIntoAnotherError(id, live.otherIssueId);
}

/**
 * An outbox row for this issue that a drain worker claimed (inside the drain's own claim window) and
 * has not marked published: the worker would publish it after the deletion. The rows are locked first,
 * so a claim still being committed is waited for — and a claim can no longer land, because the drain
 * claims with `SKIP LOCKED` and skips rows we hold. Refused, nothing changed; retry shortly.
 */
async function assertNoEventInFlight(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ claimed: boolean }[]>`
    SELECT (claimed_at IS NOT NULL
            AND claimed_at >= clock_timestamp() - ${Prisma.raw(CLAIM_TIMEOUT_SQL)}) AS claimed
    FROM "events"."outbox"
    WHERE tenant_id = ${tenantId}::uuid AND subject_id = ${id} AND published_at IS NULL
    FOR UPDATE`;
  if (rows.some((row) => row.claimed)) throw new IssueEventsInFlightError(id);
}

/**
 * Live `merged_into` rows naming this issue as the survivor whose subject is still `merged`. A subject
 * that has since been `removed` keeps its row and is not stranded by losing it (the merge side
 * ignores it the same way).
 */
async function assertNoMergedChildren(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<void> {
  const children = await tx.$queryRaw<{ issue_id: string }[]>`
    SELECT r.issue_id FROM "issue"."issue_relationship" r
    JOIN "issue"."issue" s ON s.id = r.issue_id AND s.tenant_id = r.tenant_id
    WHERE r.tenant_id = ${tenantId}::uuid AND r.other_issue_id = ${id}::uuid
      AND r.kind = 'merged_into' AND r.removed_at IS NULL AND s.state = 'merged'
    ORDER BY r.issue_id`;
  if (children.length > 0) {
    throw new IssueHasMergedChildrenError(
      id,
      children.map((c) => c.issue_id),
    );
  }
}

/**
 * Children before parents, every statement tenant-scoped. Leaves other issues' own rows alone: a
 * relationship is removed from both sides (it is derived from this issue and would dangle), but the
 * other issue keeps its events, evidence and audit — including an `issue_event` payload that names
 * this issue's id, an identifier the tombstone resolves.
 */
async function deleteDerivedRows(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<void> {
  const t = tenantId;
  // Audit entries about the issue, or about a record of its evidence. Before the evidence goes, or
  // the subquery finds nothing. An entry about *another* issue that merely cites this issue's
  // evidence stays: it is that issue's audit, and its evidence ids are identifiers.
  await tx.$executeRaw`
    DELETE FROM "audit"."audit_entry"
    WHERE tenant_id = ${t}::uuid AND (
      target_id = ${id}::uuid
      OR target_id IN (SELECT e.id FROM "evidence"."evidence" e
                       WHERE e.tenant_id = ${t}::uuid AND e.issue_id = ${id}::uuid))`;
  await tx.$executeRaw`
    DELETE FROM "evidence"."evidence_link"
    WHERE tenant_id = ${t}::uuid AND evidence_id IN (
      SELECT e.id FROM "evidence"."evidence" e
      WHERE e.tenant_id = ${t}::uuid AND e.issue_id = ${id}::uuid)`;
  await tx.$executeRaw`
    DELETE FROM "evidence"."evidence" WHERE tenant_id = ${t}::uuid AND issue_id = ${id}::uuid`;
  await tx.$executeRaw`
    DELETE FROM "issue"."issue_event" WHERE tenant_id = ${t}::uuid AND issue_id = ${id}::uuid`;
  await tx.$executeRaw`
    DELETE FROM "issue"."issue_relationship"
    WHERE tenant_id = ${t}::uuid AND (issue_id = ${id}::uuid OR other_issue_id = ${id}::uuid)`;
  // Machine steps (012). `workflow_run` has no foreign key to `issue`, so nothing would have failed.
  await tx.$executeRaw`
    DELETE FROM "workflow"."workflow_callback"
    WHERE tenant_id = ${t}::uuid AND run_id IN (
      SELECT r.id FROM "workflow"."workflow_run" r
      WHERE r.tenant_id = ${t}::uuid AND r.issue_id = ${id}::uuid)`;
  await tx.$executeRaw`
    DELETE FROM "workflow"."workflow_transition"
    WHERE tenant_id = ${t}::uuid AND run_id IN (
      SELECT r.id FROM "workflow"."workflow_run" r
      WHERE r.tenant_id = ${t}::uuid AND r.issue_id = ${id}::uuid)`;
  await tx.$executeRaw`
    DELETE FROM "workflow"."workflow_run" WHERE tenant_id = ${t}::uuid AND issue_id = ${id}::uuid`;
  // Everything ever published about this issue, sent or not: `IssueDetected` carries its
  // fingerprint. An event already delivered cannot be recalled; `IssueDeleted` is the signal.
  await tx.$executeRaw`
    DELETE FROM "events"."outbox" WHERE tenant_id = ${t}::uuid AND subject_id = ${id}`;
  // The run itself (model, tokens, cost) is the tenant's spend and 012's record, not this issue's
  // content; only its pointer at the issue goes.
  await tx.$executeRaw`
    UPDATE "agent"."agent_run" SET issue_id = NULL WHERE tenant_id = ${t}::uuid AND issue_id = ${id}::uuid`;
  // Same precedent as `agent_run` above: a `policy_decision` is evidentiary (002 FR-017, "every
  // decision explicable a year later") and must survive its issue being erased, not be deleted
  // with it. Its own append-only trigger (`policy_decision_append_only`) would normally reject any
  // column but `consumed_at`/`invalidated_reason` — safe here only because this whole transaction
  // already runs under `withPrivilegedWrite` (QUESTIONS.md "002 batch 6").
  await tx.$executeRaw`
    UPDATE "policy"."policy_decision" SET issue_id = NULL WHERE tenant_id = ${t}::uuid AND issue_id = ${id}::uuid`;
}

function toTombstone(row: {
  id: string;
  tenantId: string;
  targetId: string;
  requestedBy: string;
  reason: string;
  deletedAt: Date;
}): DeletionTombstone {
  return {
    id: row.id,
    tenantId: row.tenantId,
    targetType: 'issue',
    targetId: row.targetId,
    requestedBy: row.requestedBy,
    reason: row.reason,
    deletedAt: row.deletedAt,
  };
}
