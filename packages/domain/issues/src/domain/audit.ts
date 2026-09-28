// Mirrors prisma/schema.prisma's `audit` schema enum as a plain string union — domain code
// cannot import `@prisma/client` (infrastructure-only, 00-core.md), same pattern as `issue.ts`.

/** "The audit entry is the index over every actor — human, system, runner, agent" (FR-012). */
export type AuditActorType = 'agent' | 'human' | 'system' | 'runner';

/**
 * What a caller supplies to record an audit entry (001 T042, FR-012). `action` MUST be a
 * registered `policy_action.action_key` — 002's closed list, which does not exist in this repo
 * yet, so this type cannot validate it structurally today (the same class of gap T024 already
 * flagged for a different closed list this feature depends on but does not own).
 *
 * Deliberately has no `modelId`/`promptVersionId`/`tokens`/`cost`/`toolCalls` fields (C-13,
 * `prisma/agent-run-single-store.test.ts`'s own structural guarantee): those facts live exactly
 * once, in `agent_run`, reached through `agentRunId` — a field here would be a second place to
 * write them, exactly what that guarantee exists to make impossible.
 */
export interface NewAuditEntry {
  readonly id: string;
  readonly actorType: AuditActorType;
  readonly actorRef: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly agentRunId?: string;
  readonly policyDecisionId?: string;
  readonly outcome: string;
}

export interface AuditEntry extends NewAuditEntry {
  readonly tenantId: string;
  readonly occurredAt: Date;
}

/** SC-007: what an agent-action audit entry must resolve to, through `agentRunId` — never stored
 *  a second time on the entry itself (FR-012, C-13). */
export interface AgentRunFacts {
  readonly promptVersionId: string;
  readonly modelId: string;
}
