import type { TenantScoped } from '@healer/shared';

/**
 * Tenant-requested deletion of an issue (001 T053, FR-018, R-12). The tombstone is the only thing
 * that survives, and its shape is the guarantee: identifiers, a time and the requester — there is
 * no field a deleted excerpt, fingerprint, title or payload could be put in.
 *
 * `reason` and `requestedBy` are the requester's own statement, not something derived from the
 * deleted issue. They are the one free-text way in, so both are bounded here and again by `CHECK`
 * constraints on the table; a requester who pastes a log line into the reason has put it there.
 */
export interface DeletionTombstone {
  readonly id: string;
  readonly tenantId: string;
  readonly targetType: 'issue';
  readonly targetId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly deletedAt: Date;
}

/**
 * `already_deleted` means a tombstone for this issue existed and nothing was written — a retried
 * request, or the loser of two concurrent requests, gets the tombstone the winner left.
 */
export interface DeleteIssueResult {
  readonly outcome: 'deleted' | 'already_deleted';
  readonly tombstone: DeletionTombstone;
}

/** Placeholder bounds, like every other limit in this feature (docs/stage-0.md S0-7). */
export const DELETION_REASON_MAX_LENGTH = 500;
export const DELETION_REQUESTER_MAX_LENGTH = 128;

/** A deletion request the domain refuses — the caller's request is wrong; retrying will not help. */
export class InvalidDeletionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDeletionRequestError';
  }
}

/**
 * Other issues are still merged into this one. Deleting it would delete their `merged_into` rows and
 * leave them `merged` with nothing to say into what — a state the database refuses to commit — and
 * unmerging them is a person's decision (their states and fingerprints may no longer fit). Nothing was
 * changed: unmerge the named issues, then delete.
 */
export class IssueHasMergedChildrenError extends Error {
  constructor(
    readonly issueId: string,
    readonly childIds: readonly string[],
  ) {
    super(
      `cannot delete ${issueId}: issues are merged into it (${childIds.join(', ')}) — unmerge them first`,
    );
    this.name = 'IssueHasMergedChildrenError';
  }
}

/**
 * This issue is `merged` into another. The survivor may hold a conclusion that cites this issue's
 * evidence (FR-009), and deleting the evidence links would silently unsupport it — nothing ties a
 * link's conclusion to an issue, so the deletion cannot tell (data-model.md). Nothing was changed:
 * unmerge the issue, then delete it.
 */
export class IssueMergedIntoAnotherError extends Error {
  constructor(
    readonly issueId: string,
    readonly survivorId: string,
  ) {
    super(`cannot delete ${issueId}: it is merged into ${survivorId} — unmerge it first`);
    this.name = 'IssueMergedIntoAnotherError';
  }
}

/**
 * The deletion did not finish inside its transaction bound (waiting for a lock counts). Not
 * "concurrent, retry": for an issue too big for the bound a retry fails the same way, so the caller
 * has to raise the bound. Nothing was changed.
 */
export class DeletionTimedOutError extends Error {
  constructor(readonly issueId: string) {
    super(
      `deleting ${issueId} did not finish within its transaction time limit; nothing was changed`,
    );
    this.name = 'DeletionTimedOutError';
  }
}

/**
 * An event about this issue is claimed by an outbox drain worker that has not marked it published.
 * Deleting the row now would let the worker publish it after the deletion. Retry shortly; nothing was
 * changed.
 */
export class IssueEventsInFlightError extends Error {
  constructor(readonly issueId: string) {
    super(`cannot delete ${issueId} yet: an event about it is being published; retry`);
    this.name = 'IssueEventsInFlightError';
  }
}

/**
 * The data is not in a shape a deletion can trust — something wrote around the repository. Not
 * retryable, nothing was changed:
 * - `issue_not_deleted`: the final `DELETE` did not remove exactly the one issue row;
 * - `tombstone_for_live_issue`: a tombstone already exists for an issue that still exists.
 */
export type DeletionIntegrityReason = 'issue_not_deleted' | 'tombstone_for_live_issue';

export class DeletionIntegrityError extends Error {
  constructor(
    readonly reason: DeletionIntegrityReason,
    readonly issueId: string,
  ) {
    super(`deletion integrity failure for issue ${issueId}: ${reason.replaceAll('_', ' ')}`);
    this.name = 'DeletionIntegrityError';
  }
}

/** Both fields are required: a deletion nobody asked for, or for no stated reason, is not recorded. */
export function checkDeletionRequest(requestedBy: string, reason: string): void {
  // Postgres `text` cannot store NUL; refuse it here rather than surface a driver error mid-transaction.
  const bad = (value: string, max: number) =>
    value.trim() === '' || value.length > max || value.includes('\u0000');
  if (bad(requestedBy, DELETION_REQUESTER_MAX_LENGTH)) {
    throw new InvalidDeletionRequestError(
      `requestedBy must be 1-${DELETION_REQUESTER_MAX_LENGTH} characters`,
    );
  }
  if (bad(reason, DELETION_REASON_MAX_LENGTH)) {
    throw new InvalidDeletionRequestError(
      `reason must be 1-${DELETION_REASON_MAX_LENGTH} characters`,
    );
  }
}

/**
 * Removes the issue and everything derived from it — events, evidence and the links citing it,
 * relationships in both directions, machine steps, audit entries about it or its evidence, and the
 * outbox rows about it — in one transaction, and leaves a `DeletionTombstone`. `NotFoundError` for
 * a missing issue, another tenant's and a malformed id alike, unless this tenant already deleted it
 * (then `already_deleted`). Publishes `IssueDeleted` (tombstone id only) in the same transaction.
 * Validates `requestedBy` and `reason` itself (`InvalidDeletionRequestError`). Refuses, changing
 * nothing: `IssueHasMergedChildrenError`, `IssueMergedIntoAnotherError`, `IssueEventsInFlightError`
 * (retry shortly); `DeletionTimedOutError` when a lock wait or the transaction outlasts its bound;
 * `DeletionIntegrityError` when the data is not in a shape a deletion can trust;
 * `ConcurrentModificationError` for a deadlock or serialisation failure (retry).
 */
export interface IssueDeletionRepository {
  deleteIssue(
    where: TenantScoped<{ readonly id: string }>,
    requestedBy: string,
    reason: string,
  ): Promise<DeleteIssueResult>;
  /**
   * The reader of R-12: the tombstone this tenant left for `id`, or null. A deleted id is otherwise
   * indistinguishable from one that never existed. Another tenant's tombstone is null, a malformed
   * id is null.
   */
  findTombstone(where: TenantScoped<{ readonly id: string }>): Promise<DeletionTombstone | null>;
}
