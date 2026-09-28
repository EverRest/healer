import type { TenantScoped } from '@healer/shared';
import type { Issue } from './issue.js';

/**
 * Merge and unmerge (001 T049/T050, FR-016, R-08). A separate port from `IssueRepository` because
 * it is a separate capability: a caller that can only transition, record and correlate has no way
 * to reach it, the same reasoning as `StalenessRepository`'s narrow `Pick`.
 *
 * A merge is a `merged_into` relationship row, the state change to `merged`, an event and the
 * outbox events, in one transaction — and **nothing else**. Evidence is not copied or moved and
 * neither issue's counts change, so an unmerge has nothing to give back: "counts restored to both
 * sides, not split" holds because they were never divided. The state and the row cannot be written
 * apart: `IssueRepository.transition` refuses `merged`, and the database refuses to commit a merged
 * issue without a live row, or a live row on an issue that is not merged.
 */
/**
 * What a merge did. `already_merged` means the source was **already merged into this very target**
 * and nothing was written — the caller (an HTTP retry, a job that ran twice) must be able to tell
 * that apart from a merge it just made. A repeat carrying a different reason or actor is still
 * `already_merged`: the first merge's reason and actor are the record, and the new ones are dropped.
 */
export interface MergeResult {
  readonly outcome: 'merged' | 'already_merged';
  readonly issue: Issue;
}

/**
 * What an unmerge did. `not_merged` means there was no live `merged_into` row — the issue was
 * unmerged already, or never merged — and nothing was written. A result rather than an error
 * because the two cases are indistinguishable from the issue's state, and an unmerge retried after
 * it succeeded must not turn into a failure.
 */
export interface UnmergeResult {
  readonly outcome: 'unmerged' | 'not_merged';
  readonly issue: Issue;
}

export interface IssueMergeRepository {
  /**
   * Merges `id` into `intoId`. Both rows are locked (in id order) before either is read, so what
   * `checkMerge` validated is what is written. Ids are case-insensitive. `NotFoundError` covers a
   * missing issue on either side and another tenant's alike; `InvalidMergeError` covers a merge the
   * domain refuses; `InvalidIssueTransitionError` a source that cannot be merged at all
   * (`removed`, even when its row is still live); `ConcurrentModificationError` a lost race.
   * Human only — the row's `rule` is `human` — which is why there is no `cause` to pass. A repeat
   * of a merge that already stands returns `already_merged` (see `MergeResult`).
   */
  merge(
    where: TenantScoped<{ readonly id: string; readonly intoId: string }>,
    actorRef: string,
    reason: string,
  ): Promise<MergeResult>;
  /**
   * Sets `removed_at` on the live `merged_into` row and returns the issue to the state its `merged`
   * event recorded it leaving, in one transaction. An issue with no live row returns `not_merged`
   * (see `UnmergeResult`). Throws `UnmergeFingerprintTakenError`, leaving the merge in place, if the
   * restored state is an open one and another open issue has taken the fingerprint in the meantime
   * (a merge frees it); `InvalidIssueTransitionError` if the issue was removed after it was merged;
   * `MergeIntegrityError` — nothing changed — if the merge record is missing or the rows are not
   * in a shape the merge could have left, rather than guessing a state to restore.
   */
  unmerge(where: TenantScoped<{ readonly id: string }>, actorRef: string): Promise<UnmergeResult>;
}
