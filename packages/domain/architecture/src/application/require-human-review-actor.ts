import { randomUUID } from 'node:crypto';
import { HealerError, scope, type TenantContext } from '@healer/shared';
import { GRAPH_CONFIRM_CAPABILITY } from '../domain/capabilities.js';
import type { DraftReviewRepository } from '../domain/draft-review-repository.js';
import type { GraphReviewActor, NewGraphAuditEntry } from '../domain/graph-audit-entry.js';

/**
 * FR-010/SC-002 (T025): confirmation and rejection are human-actor-only, structurally — no
 * registry exists yet to check `graph:confirm` against (`capabilities.ts`'s own doc comment), so
 * the actor-type check *is* the enforcement today, not a stand-in for one. A refused attempt is
 * still audited (the second half of FR-010/T025) — written directly, not inside any larger
 * transaction, since there is nothing else to commit alongside it; `recordAuditEntry` is the one
 * write both commands' repository needs for exactly this case.
 *
 * Shared by `confirmDraftItems` and `rejectDraftItems` — the same refusal, the same audit shape,
 * differing only in `action`/`targetId`, which the caller already has.
 */
export async function requireHumanReviewActor(
  repo: DraftReviewRepository,
  context: TenantContext,
  actor: GraphReviewActor,
  action: string,
  targetId: string,
  reason: string,
): Promise<void> {
  if (actor.actorType === 'human') return;

  const base = {
    id: randomUUID(),
    actorRef: actor.actorRef,
    action,
    targetType: 'draft_item' as const,
    targetId,
    reason,
    evidenceIds: [] as string[],
    outcome: 'refused' as const,
  };
  // Explicit per-branch literals, not one object with a conditional spread: `NewGraphAuditEntry`
  // is a discriminated union on `actorType`, and a single construction can't prove to the
  // compiler which member it built (review-caught during T026 — see QUESTIONS.md).
  const entry: NewGraphAuditEntry =
    actor.actorType === 'agent'
      ? { ...base, actorType: 'agent', agentRunId: actor.agentRunId }
      : { ...base, actorType: actor.actorType };
  await repo.recordAuditEntry(scope(context, entry));
  throw new HealerError(
    'HUMAN_ACTOR_REQUIRED',
    `${GRAPH_CONFIRM_CAPABILITY} requires a human actor — refused for actorType '${actor.actorType}' (FR-010)`,
    { actorType: actor.actorType },
  );
}
