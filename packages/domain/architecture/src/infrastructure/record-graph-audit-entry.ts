import { Prisma, type PrismaClient } from '@healer/prisma-client';
import type { NewGraphAuditEntry } from '../domain/graph-audit-entry.js';

/**
 * `audit_entry` write for this package (004 T026, FR-012, FR-025) — mirrors
 * `packages/domain/policy/src/infrastructure/record-audit-entry.ts` in spirit, but takes a plain
 * `{ tenantId } & NewGraphAuditEntry` rather than the branded `TenantScoped`: every call site
 * here is already inside a transaction whose `tenantId` came from a `TenantScoped` input one
 * level up (the repository-interface boundary, `DraftReviewRepository.recordAuditEntry`), so
 * re-deriving the brand at this inner layer would gain nothing — `TenantScoped` guards a
 * *repository read* against a caller-forged tenant id, not a write already inside a transaction
 * this package's own public methods opened.
 *
 * Two call shapes: inside the confirm/reject transaction (a `Prisma.TransactionClient`, same as
 * `tx` everywhere else in this file's siblings), and standalone for a refused attempt (T025) —
 * which must commit even though the command that attempted it throws immediately afterwards, so
 * that call passes the plain `PrismaClient` instead. Both satisfy the same minimal shape
 * (`auditEntry.create`), which is all this function calls.
 */
export async function recordGraphAuditEntry(
  tx: Prisma.TransactionClient | PrismaClient,
  entry: { readonly tenantId: string } & NewGraphAuditEntry,
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
      outcome: entry.outcome,
      before: entry.before === undefined ? Prisma.DbNull : (entry.before as Prisma.InputJsonValue),
      after: entry.after === undefined ? Prisma.DbNull : (entry.after as Prisma.InputJsonValue),
      graphVersion: entry.graphVersion ?? null,
    },
  });
}
