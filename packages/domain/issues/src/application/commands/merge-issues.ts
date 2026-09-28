import { scope, type TenantContext } from '@healer/shared';
import type {
  IssueMergeRepository,
  MergeResult,
  UnmergeResult,
} from '../../domain/merge-repository.js';

/**
 * `MergeIssues` / `UnmergeIssues` (001 T049/T050, `plan.md`'s named application layer, FR-016,
 * R-08). Thin on purpose, same reasoning as `AttachLink`: the guarantees — one transaction for the
 * row, the state, the event and the outbox; evidence never copied; the state restored from the
 * merge's own event — hold in `IssueMergeRepository`'s implementation and the database. These give
 * a caller (the HTTP route, when it lands) one named place that scopes the call to the tenant.
 * Merging is a human's call, so `actorRef` is the person; see `IssueMergeRepository.merge`.
 *
 * The result says whether anything happened: a merge that already stands comes back
 * `already_merged`, and the reason and actor of the repeat are **dropped** — the first merge's are the
 * record. An unmerge with nothing to undo comes back `not_merged`. A caller that answers a request
 * (the HTTP route) should surface the outcome rather than report success either way.
 */
export function mergeIssues(
  repo: IssueMergeRepository,
  context: TenantContext,
  input: {
    readonly id: string;
    readonly intoId: string;
    readonly actorRef: string;
    readonly reason: string;
  },
): Promise<MergeResult> {
  return repo.merge(
    scope(context, { id: input.id, intoId: input.intoId }),
    input.actorRef,
    input.reason,
  );
}

export function unmergeIssue(
  repo: IssueMergeRepository,
  context: TenantContext,
  input: { readonly id: string; readonly actorRef: string },
): Promise<UnmergeResult> {
  return repo.unmerge(scope(context, { id: input.id }), input.actorRef);
}
