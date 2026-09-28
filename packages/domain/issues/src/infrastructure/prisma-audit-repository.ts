import type { TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import type { AgentRunFacts, AuditActorType, AuditEntry, NewAuditEntry } from '../domain/audit.js';
import type { AuditRepository } from '../domain/audit-repository.js';

function toDomain(row: {
  id: string;
  tenantId: string;
  actorType: AuditActorType;
  actorRef: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  evidenceIds: string[];
  agentRunId: string | null;
  policyDecisionId: string | null;
  outcome: string;
  occurredAt: Date;
}): AuditEntry {
  const shared = {
    id: row.id,
    tenantId: row.tenantId,
    actorRef: row.actorRef,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    evidenceIds: row.evidenceIds,
    ...(row.policyDecisionId !== null ? { policyDecisionId: row.policyDecisionId } : {}),
    outcome: row.outcome,
    occurredAt: row.occurredAt,
  };
  if (row.actorType === 'agent') {
    // `record` always writes `agentRunId` alongside `actorType: 'agent'` (the type makes the two
    // unrepresentable apart) — a row that fails this only reaches here via a raw-SQL bypass, and
    // fabricating a fake resolution would be worse than refusing to read it back as this type.
    if (row.agentRunId === null) {
      throw new Error(`audit entry ${row.id} has actorType 'agent' but no agentRunId`);
    }
    return { ...shared, actorType: 'agent', agentRunId: row.agentRunId };
  }
  return { ...shared, actorType: row.actorType };
}

export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: TenantScoped<NewAuditEntry>): Promise<AuditEntry> {
    const row = await this.prisma.auditEntry.create({
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
    return toDomain(row);
  }

  async listByTarget(
    where: TenantScoped<{ readonly targetType: string; readonly targetId: string }>,
  ): Promise<readonly AuditEntry[]> {
    const rows = await this.prisma.auditEntry.findMany({
      where: { tenantId: where.tenantId, targetType: where.targetType, targetId: where.targetId },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map(toDomain);
  }

  async resolveAgentRunFacts(
    where: TenantScoped<{ readonly agentRunId: string }>,
  ): Promise<AgentRunFacts | null> {
    const row = await this.prisma.agentRun.findFirst({
      where: { id: where.agentRunId, tenantId: where.tenantId },
      select: { promptVersionId: true, modelId: true },
    });
    return row === null ? null : { promptVersionId: row.promptVersionId, modelId: row.modelId };
  }
}
