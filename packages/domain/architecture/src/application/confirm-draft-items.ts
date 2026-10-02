import { scope, type TenantContext } from '@healer/shared';
import type {
  ConfirmDraftItemsResult,
  DraftReviewRepository,
} from '../domain/draft-review-repository.js';
import type { GraphReviewActor } from '../domain/graph-audit-entry.js';
import { requireHumanReviewActor } from './require-human-review-actor.js';

export interface ConfirmDraftItemsCommandInput {
  readonly draftId: string;
  readonly itemIds: readonly string[];
  readonly actor: GraphReviewActor;
  readonly reason: string;
  readonly now?: Date;
}

/**
 * T026: the human-actor gate (FR-010, T025), then one serialised transaction minting exactly one
 * `graph_version` (`DraftReviewRepository.confirmDraftItems`). Supersede detection (T027/T028) and
 * the version race are the repository's job — this layer only decides *whether the caller may
 * ask at all*.
 */
export async function confirmDraftItems(
  repo: DraftReviewRepository,
  context: TenantContext,
  input: ConfirmDraftItemsCommandInput,
): Promise<ConfirmDraftItemsResult> {
  await requireHumanReviewActor(
    repo,
    context,
    input.actor,
    'architecture.draft_item.confirm',
    input.draftId,
    input.reason,
  );

  return repo.confirmDraftItems(
    scope(context, {
      draftId: input.draftId,
      itemIds: input.itemIds,
      actorRef: input.actor.actorRef,
      reason: input.reason,
      ...(input.now !== undefined ? { now: input.now } : {}),
    }),
  );
}
