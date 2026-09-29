// Mirrors 001's `audit_entry` shape (packages/domain/issues/src/domain/audit.ts) as a plain
// local type, for the same reason `issue-enums.ts` mirrors 001's issue enums and `action-class.ts`
// mirrors this package's own schema fact: a cross-module domain import would couple this package
// to 001's package boundary instead of to the shared table shape both already depend on
// (`policy_action.action_key` — the invariant this type's `action` field carries — is this
// package's own closed list, not 001's).

/** "The audit entry is the index over every actor — human, system, runner, agent" (001 FR-012). */
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
 * What a caller supplies to record an audit entry (mirrors 001's `NewAuditEntry`). A
 * discriminated union on `actorType`, not a plain `agentRunId?: string`: an agent-caused entry
 * must resolve to a real `agent_run` (001 SC-007), and a plain optional field would let
 * `{ actorType: 'agent' }` with no `agentRunId` type-check, silently promising a resolution
 * nothing could ever deliver.
 */
export type NewAuditEntry =
  | (AuditEntryFields & { readonly actorType: 'agent'; readonly agentRunId: string })
  | (AuditEntryFields & {
      readonly actorType: 'human' | 'system' | 'runner';
      readonly agentRunId?: never;
    });
