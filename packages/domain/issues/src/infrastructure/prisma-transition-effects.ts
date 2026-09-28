import { randomUUID } from 'node:crypto';
import type { Prisma } from '@healer/prisma-client';
import { resolutionForCause, type IssueResolution } from '../domain/events.js';
import type { TransitionAudit } from '../domain/repository.js';
import type { IssueEventCause } from '../domain/state-machine.js';

/** What a transition writes besides the state change and its event, decided before any write. */
export interface TransitionEffects {
  /** Set when the transition lands on `resolved`: the `IssueResolved` to publish. */
  readonly resolution?: IssueResolution;
  /** Set when the caller asked for an audit entry: its action and reason. */
  readonly audit?: { readonly action: string; readonly reason: string };
}

/**
 * Validates the extras of a transition and decides what to write, **before** the first write, so a
 * refusal leaves nothing behind. The resolution is derived from the cause here, at the publish
 * site (`resolutionForCause`), not inferred from `to === 'resolved'` alone.
 */
export function planTransitionEffects(
  to: string,
  cause: IssueEventCause,
  reason: string | undefined,
  audit: TransitionAudit | undefined,
): TransitionEffects {
  if (audit !== undefined && (cause !== 'human' || reason === undefined)) {
    throw new Error(
      'an audit entry is written for human-caused transitions only, and needs a reason (FR-012)',
    );
  }
  return {
    ...(to === 'resolved' ? { resolution: resolutionForCause(cause) } : {}),
    ...(audit !== undefined && reason !== undefined
      ? { audit: { action: audit.action, reason } }
      : {}),
  };
}

/** FR-012: the human action's index entry, in the transaction of the change it describes. */
export async function recordTransitionAudit(
  tx: Prisma.TransactionClient,
  where: { readonly tenantId: string; readonly issueId: string; readonly actorRef: string },
  audit: NonNullable<TransitionEffects['audit']>,
): Promise<void> {
  await tx.auditEntry.create({
    data: {
      id: randomUUID(),
      tenantId: where.tenantId,
      actorType: 'human',
      actorRef: where.actorRef,
      action: audit.action,
      targetType: 'issue',
      targetId: where.issueId,
      reason: audit.reason,
      evidenceIds: [],
      outcome: 'ok',
    },
  });
}
