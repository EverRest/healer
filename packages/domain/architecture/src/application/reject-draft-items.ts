import { scope, type TenantContext } from '@healer/shared';
import type {
  DraftReviewRepository,
  RejectDraftItemsResult,
} from '../domain/draft-review-repository.js';
import type { GraphReviewActor } from '../domain/graph-audit-entry.js';
import { requireHumanReviewActor } from './require-human-review-actor.js';

export interface RejectDraftItemsCommandInput {
  readonly draftId: string;
  readonly itemIds: readonly string[];
  readonly actor: GraphReviewActor;
  readonly reason: string;
  readonly now?: Date;
}

/**
 * T026: the same human-actor gate as `confirmDraftItems` (FR-010), then one serialised
 * transaction that writes `proposal_rejection` rows (FR-011 — what `loadRejectedDigests`/T023's
 * filter reads on the next run) and closes the items. Mints **no** `graph_version`:
 * `GraphVersion.mintedBy`'s closed set has no `rejection` member, because rejecting changes
 * nothing in the graph.
 */
export async function rejectDraftItems(
  repo: DraftReviewRepository,
  context: TenantContext,
  input: RejectDraftItemsCommandInput,
): Promise<RejectDraftItemsResult> {
  await requireHumanReviewActor(
    repo,
    context,
    input.actor,
    'architecture.draft_item.reject',
    input.draftId,
    input.reason,
  );

  return repo.rejectDraftItems(
    scope(context, {
      draftId: input.draftId,
      itemIds: input.itemIds,
      actorRef: input.actor.actorRef,
      reason: input.reason,
      ...(input.now !== undefined ? { now: input.now } : {}),
    }),
  );
}
