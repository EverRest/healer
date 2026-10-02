// Mirrors `audit.audit_entry`'s shape as a plain local type — the same convention
// `packages/domain/policy/src/domain/audit-entry.ts` already established (and documented,
// QUESTIONS.md "002 T031"/the record-audit-entry.ts comment) rather than importing
// `@healer/domain-issues`: a cross-domain-package dependency has no precedent in this repo.

/** "The audit entry is the index over every actor — human, system, runner, agent" (001 FR-012). */
export type GraphAuditActorType = 'agent' | 'human' | 'system' | 'runner';

interface GraphAuditEntryFields {
  readonly id: string;
  readonly actorRef: string;
  readonly action: string;
  readonly targetType: 'draft_item' | 'graph_node' | 'graph_edge';
  readonly targetId: string;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly outcome: 'ok' | 'refused';
  /** 004 T026 (FR-025): "before and after state" and "the minted graph_version" — three columns
   *  `20261004010000_t026_audit_entry_before_after` added to the shared table. `null`/absent on
   *  a refused attempt (nothing changed) and on a rejection (no graph version is minted — reject
   *  is absent from `GraphVersion.mintedBy`'s closed set by construction). */
  readonly before?: unknown;
  readonly after?: unknown;
  readonly graphVersion?: number;
}

/** A discriminated union on `actorType`, same shape and same reason as 001's/002's own
 *  `NewAuditEntry` (SC-007: an agent-caused entry must resolve to a real `agent_run`). Confirm/
 *  reject refuse every non-human actor before a write is ever attempted (FR-010), but the
 *  *refusal itself* is still audited (T025) under whatever actor type was refused — `agent` needs
 *  an `agentRunId` to stay resolvable the same way any other agent-caused entry does. */
export type NewGraphAuditEntry =
  | (GraphAuditEntryFields & { readonly actorType: 'agent'; readonly agentRunId: string })
  | (GraphAuditEntryFields & {
      readonly actorType: 'human' | 'system' | 'runner';
      readonly agentRunId?: never;
    });

/**
 * What a caller of `confirmDraftItems`/`rejectDraftItems` identifies itself as (FR-010). A
 * discriminated union, not `{ actorType, actorRef, agentRunId?: string }`: SC-007 needs every
 * agent-caused audit entry (including a *refused* one, T025) to resolve to a real `agent_run`, so
 * "agent with no agentRunId" must not type-check — the same shape `NewGraphAuditEntry` already
 * enforces one level down, pushed to the command's own public input instead of letting a caller
 * reach for a fabricated placeholder here.
 */
export type GraphReviewActor =
  | { readonly actorType: 'agent'; readonly actorRef: string; readonly agentRunId: string }
  | { readonly actorType: 'human' | 'system' | 'runner'; readonly actorRef: string };
