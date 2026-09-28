// Mirrors prisma/schema.prisma's `audit` schema enum as a plain string union — domain code
// cannot import `@prisma/client` (infrastructure-only, 00-core.md), same pattern as `issue.ts`.

/** "The audit entry is the index over every actor — human, system, runner, agent" (FR-012). */
export type AuditActorType = 'agent' | 'human' | 'system' | 'runner';

interface AuditEntryFields {
  readonly id: string;
  readonly actorRef: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly policyDecisionId?: string;
  readonly outcome: string;
}

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
 *
 * A discriminated union on `actorType`, not a plain `agentRunId?: string` (review finding, post-
 * T044): SC-007 requires every *agent*-action entry to resolve to a real `agent_run` — a plain
 * optional field let `{ actorType: 'agent' }` with no `agentRunId` type-check, silently promising
 * a resolution `resolveAgentRunFacts` could never deliver, and let `{ actorType: 'human',
 * agentRunId: '...' }` type-check just as validly with no meaning at all. Making the pairing
 * unrepresentable costs nothing today (no real caller exists yet) and is the only point this is
 * ever this cheap to fix (docs/patterns.md).
 */
export type NewAuditEntry =
  | (AuditEntryFields & { readonly actorType: 'agent'; readonly agentRunId: string })
  | (AuditEntryFields & {
      readonly actorType: 'human' | 'system' | 'runner';
      readonly agentRunId?: never;
    });

export type AuditEntry = NewAuditEntry & { readonly tenantId: string; readonly occurredAt: Date };

/** SC-007: what an agent-action audit entry must resolve to, through `agentRunId` — never stored
 *  a second time on the entry itself (FR-012, C-13). */
export interface AgentRunFacts {
  readonly promptVersionId: string;
  readonly modelId: string;
}
