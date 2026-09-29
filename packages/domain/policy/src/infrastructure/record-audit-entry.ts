import type { Prisma } from '@healer/prisma-client';
import type { TenantScoped } from '@healer/shared';
import type { NewAuditEntry } from '@healer/domain-issues';

/**
 * `audit_entry` written in the *same* transaction as the decision, publish, grant, revoke or
 * budget change it describes (T017, FR-012, FR-020) — the guarantee
 * `packages/domain/issues/src/infrastructure/prisma-transition-effects.ts`'s
 * `recordTransitionAudit` already gives 001's own transitions, generalised here for this
 * package's future command handlers (T019 `PublishRuleset`, T039, T045, ...), none of which exist
 * yet in this batch.
 *
 * Takes the transaction rather than a `PrismaClient` — there is no overload that writes outside
 * one (same shape as `packages/events/src/outbox.ts`'s `OutboxTransaction`). Reuses
 * `NewAuditEntry` from `@healer/domain-issues` — the single authority for the
 * `actorType`/`agentRunId` pairing (audit.ts) — rather than re-declaring that invariant here
 * (AGENTS.md: a closed list has exactly one authority).
 */
export async function recordAuditEntry(
  tx: Prisma.TransactionClient,
  entry: TenantScoped<NewAuditEntry>,
): Promise<void> {
  await tx.auditEntry.create({
    data: {
      id: entry.id,
      tenantId: entry.tenantId,
      actorType: entry.actorType,
      actorRef: entry.actorRef,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      reason: entry.reason,
      evidenceIds: [...entry.evidenceIds],
      agentRunId: entry.agentRunId ?? null,
      policyDecisionId: entry.policyDecisionId ?? null,
      outcome: entry.outcome,
    },
  });
}
