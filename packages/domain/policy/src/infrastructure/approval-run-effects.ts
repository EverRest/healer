import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HealerError, NotFoundError } from '@healer/shared';
import { Prisma } from '@healer/prisma-client';

/**
 * What an approval does to the 012 `workflow_run` it parks, all inside the caller's transaction
 * (012 FR-029, FR-030): park on an `approval` callback with the deadline projected onto
 * `expires_at`, deliver that callback, and — on a lapse — move the run to `needs_human`. These
 * are plain writes to 012's tables because 012's machine is pure domain logic with no persisted
 * stepper in this repository yet (QUESTIONS.md "002 Phase 7"); a stepper that lands later reads
 * the same rows.
 */

interface LockedRun {
  readonly state: string;
  readonly deadline_at: Date | null;
  readonly terminal_state: string | null;
  readonly awaiting: { readonly kind?: string } | null;
}

/** `FOR UPDATE` on the run: every approval write that reads the run's deadline or state and then
 *  writes it back holds this lock, so two of them cannot interleave on a stale read. */
export async function lockRun(
  tx: Prisma.TransactionClient,
  tenantId: string,
  runId: string,
): Promise<{
  state: string;
  deadlineAt: Date | null;
  terminalState: string | null;
  awaiting: { readonly kind?: string } | null;
}> {
  const rows = await tx.$queryRaw<LockedRun[]>`
    SELECT state, deadline_at, terminal_state, awaiting
    FROM "workflow"."workflow_run"
    WHERE tenant_id = ${tenantId}::uuid AND id = ${runId}::uuid
    FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('workflow_run');
  return {
    state: row.state,
    deadlineAt: row.deadline_at,
    terminalState: row.terminal_state,
    awaiting: row.awaiting,
  };
}

/** Parks the run: `deadline_at` becomes `expiresAt` (never later than the old deadline, because
 *  `projectExpiry` took the minimum), and an `approval` callback row exists for it. The token is
 *  generated and discarded: a human resolves through the authenticated API, not by presenting a
 *  token, so the row exists to be *delivered* (consumed), not redeemed. */
export async function parkRun(
  tx: Prisma.TransactionClient,
  input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly approvalId: string;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await tx.workflowRun.update({
    where: { id: input.runId },
    data: {
      deadlineAt: input.expiresAt,
      awaiting: { kind: 'approval', approvalId: input.approvalId },
    },
  });
  await tx.workflowCallback.create({
    data: {
      id: randomUUID(),
      runId: input.runId,
      tenantId: input.tenantId,
      kind: 'approval',
      approvalId: input.approvalId,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      expiresAt: input.expiresAt,
    },
  });
}

/** 012 FR-030: the first delivery consumes the callback; a repeat only counts. Idempotent. The
 *  callback is found by **its approval**, never by run, so one approval's delivery can neither
 *  consume nor orphan another's. A delivery that matches no row is an error — a "success" that
 *  woke nothing would leave the run waiting on a callback that never arrives. */
export async function deliverApprovalCallback(
  tx: Prisma.TransactionClient,
  input: { readonly tenantId: string; readonly approvalId: string; readonly now: Date },
): Promise<void> {
  const base = {
    approvalId: input.approvalId,
    tenantId: input.tenantId,
    kind: 'approval' as const,
  };
  const first = await tx.workflowCallback.updateMany({
    where: { ...base, consumedAt: null },
    data: { consumedAt: input.now, receivedCount: { increment: 1 } },
  });
  if (first.count > 0) return;
  const repeat = await tx.workflowCallback.updateMany({
    where: base,
    data: { receivedCount: { increment: 1 } },
  });
  if (repeat.count === 0) throw new NotFoundError('workflow_callback');
}

/** The run is no longer waiting on this approval (it was resolved): clear the marker. The run's
 *  own stepper takes it from here via the delivered callback. */
export async function clearAwaiting(
  tx: Prisma.TransactionClient,
  input: { readonly runId: string },
): Promise<void> {
  await tx.workflowRun.update({ where: { id: input.runId }, data: { awaiting: Prisma.DbNull } });
}

/** A lapse, a rejection or a revocation stops the workflow (FR-016): the run goes to the terminal
 *  `needs_human`, the transition recorded with the cause that stopped it (`timeout` for the
 *  deadline tick, `human` for a rejection, `policy` for a revocation). A run already terminal is
 *  left alone. */
export async function moveRunToNeedsHuman(
  tx: Prisma.TransactionClient,
  input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly now: Date;
    readonly cause: 'timeout' | 'human' | 'policy';
    readonly actorRef: string;
  },
): Promise<void> {
  const run = await lockRun(tx, input.tenantId, input.runId);
  if (run.terminalState !== null) return;
  await tx.workflowRun.update({
    where: { id: input.runId },
    data: {
      state: 'needs_human',
      terminalState: 'needs_human',
      awaiting: Prisma.DbNull,
      deadlineAt: null,
    },
  });
  await tx.workflowTransition.create({
    data: {
      id: randomUUID(),
      tenantId: input.tenantId,
      runId: input.runId,
      fromState: run.state,
      toState: 'needs_human',
      cause: input.cause,
      actorRef: input.actorRef,
      occurredAt: input.now,
    },
  });
}

export class ApprovalRunTerminalError extends HealerError {
  constructor(runId: string) {
    super(
      'PRECONDITION_FAILED',
      `workflow run ${runId} is terminal; nothing is waiting for approval`,
    );
    this.name = 'ApprovalRunTerminalError';
  }
}
