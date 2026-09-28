import type { Issue, IssueState } from './issue.js';

/** A merge the domain refuses — the caller's request is wrong, retrying it will not help. */
export class InvalidMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMergeError';
  }
}

/**
 * `issue_event.payload` is "bounded, no free-form customer text" (data-model.md), and the reason is
 * the one free-text field a merge takes. A placeholder bound, like every other window and limit in
 * this feature (docs/stage-0.md S0-7): long enough for a sentence a person writes at 3am, short
 * enough that the payload stays a record and not a document.
 */
export const MERGE_REASON_MAX_LENGTH = 500;

/**
 * The merge/unmerge data is not in a shape the operations can trust (001 T050): the state says one
 * thing and the rows say another, or the record an unmerge restores from is missing. Not the
 * caller's mistake and not retryable — something wrote around the repository. `reason` says which,
 * so a caller (or a person reading a log) can tell them apart:
 * - `merge_record_missing`: the live `merged_into` row has no `merged` event tied to it by
 *   `relationshipId`, so there is no recorded state to restore (an older merge's event is *not* a
 *   substitute — it describes a different row);
 * - `relationship_vanished`: the row was withdrawn by someone else while the unmerge held the issue;
 * - `merged_without_relationship`: the issue is `merged` with no live row.
 * All three fail closed: nothing is written.
 */
export type MergeIntegrityReason =
  'merge_record_missing' | 'relationship_vanished' | 'merged_without_relationship';

export class MergeIntegrityError extends Error {
  constructor(
    readonly reason: MergeIntegrityReason,
    readonly issueId: string,
  ) {
    super(`merge integrity failure for issue ${issueId}: ${reason.replaceAll('_', ' ')}`);
    this.name = 'MergeIntegrityError';
  }
}

/**
 * An unmerge that would restore an issue into an open state while another open issue has taken its
 * fingerprint (the merge freed the slot). Deliberately not `FingerprintAlreadyOpenError`:
 * `ingestSignal` reads that class as "someone else just created it, attach to theirs", which is the
 * wrong reading here — a person has to resolve or merge the other issue, then retry.
 */
export class UnmergeFingerprintTakenError extends Error {
  constructor(
    readonly issueId: string,
    readonly fingerprint: string,
    readonly restoreTo: IssueState,
  ) {
    super(
      `cannot unmerge ${issueId}: restoring it to ${restoreTo} would leave two open issues with fingerprint ${fingerprint}`,
    );
    this.name = 'UnmergeFingerprintTakenError';
  }
}

/**
 * What must hold before `source` may be merged into `target` (001 T049, FR-016, R-08). Pure, and
 * called by the repository **under the row locks of both issues**, so what it is handed is the
 * committed state of both and stays that way until the transaction ends.
 *
 * The shape it enforces is a forest of depth one: a merged issue is never a target, and a target is
 * never merged. That is what makes "the survivor" a single issue rather than a chain to walk, and
 * what lets the unmerge of one issue never strand another. Whether the two issues are *really* the
 * same is deliberately not checked (component, environment, fingerprint may all differ): the
 * judgement is a person's, often made at 3am (R-08), and the merge is reversible for that reason.
 *
 * Returns `already_merged` only when the source **is** `merged` and its live row names this very
 * target — the merge that already happened. Everything else about a repeat is still checked (the
 * target has not since been removed, the reason is well formed); a *different* reason on a repeat
 * is accepted and ignored — the first merge's reason is the record. A `removed` source is left for
 * `mergeTransition` to refuse, so it is never reported as merged.
 */
export function checkMerge(
  source: Issue,
  target: Issue,
  liveTargetId: string | null,
  sourceHasMergedChildren: boolean,
  reason: string,
): 'merge' | 'already_merged' {
  if (source.id === target.id) throw new InvalidMergeError('an issue cannot be merged into itself');
  if (reason.trim() === '' || reason.length > MERGE_REASON_MAX_LENGTH) {
    throw new InvalidMergeError(`reason must be 1-${MERGE_REASON_MAX_LENGTH} characters`);
  }
  if (target.state === 'merged' || target.state === 'removed') {
    throw new InvalidMergeError(`cannot merge into an issue that is ${target.state}`);
  }
  if (source.state === 'merged') {
    if (liveTargetId === null)
      throw new MergeIntegrityError('merged_without_relationship', source.id);
    if (liveTargetId === target.id) return 'already_merged';
    throw new InvalidMergeError('already merged into another issue — unmerge it first');
  }
  if (sourceHasMergedChildren) {
    throw new InvalidMergeError('other issues are merged into it — unmerge them first');
  }
  return 'merge';
}
