import { NotFoundError, scope, type TenantContext } from '@healer/shared';
import type { Issue } from '../../domain/issue.js';
import type { IssueRepository } from '../../domain/repository.js';
import {
  ConcurrentModificationError,
  InvalidIssueTransitionError,
} from '../../domain/state-machine.js';

/** All a close may touch — no `recordOccurrence`, no `markStale`, nothing but read and resolve. */
export type ClosingRepository = Pick<IssueRepository, 'findById' | 'transition'>;

/**
 * The audit `action` a close records (FR-012). **Not a registered `policy_action.action_key`**:
 * that closed list belongs to 002, which does not exist yet, so this is a placeholder of the same
 * standing as every other audit action in this feature (QUESTIONS.md "001 T042").
 */
export const CLOSE_AUDIT_ACTION = 'issue.close';

/** How many times a close is attempted against a serialisation conflict that changed nothing. A
 *  placeholder bound, not a tuned number: enough to ride out a signal landing on the same row. */
const MAX_CLOSE_ATTEMPTS = 3;

/**
 * `CloseIssue` (001 T057, FR-021, C-09, quickstart 27): a person resolves the issue. The
 * repository turns the transition into `IssueResolved(self_resolved)` with no verification
 * evidence — nothing here can supply any, and nothing here labels it as verified — and writes the
 * audit entry for the human actor in the same transaction.
 *
 * Idempotent by state, not by a stored key: closing an issue that is already `resolved` writes
 * nothing and returns it as it stands (`closed: false`), so a retried request, a double click and
 * a lost race against another close all land on the one resolution and the one event. The original
 * actor and reason stay on the original `issue_event`; a second reason is not appended. `closed`
 * is how the caller tells the two apart — the route reports a no-op to the client with it.
 * `merged`/`removed` refuse (`InvalidIssueTransitionError`) — closing something that has already
 * left the lifecycle is a conflict, not a success.
 *
 * A serialisation conflict is retried, up to `MAX_CLOSE_ATTEMPTS`, only when a re-read shows the
 * issue in the same state it was in when the close began: a signal landing on the row is benign
 * and retryable. If the state moved to anything else the conflict is genuine and surfaces.
 */
export async function closeIssue(
  repo: ClosingRepository,
  context: TenantContext,
  issueId: string,
  actorRef: string,
  reason: string,
): Promise<{ readonly issue: Issue; readonly closed: boolean }> {
  const where = scope(context, { id: issueId });
  const initial = await repo.findById(where);
  if (initial === null) throw new NotFoundError('Issue');
  if (initial.state === 'resolved') return { issue: initial, closed: false };

  for (let attempt = 1; ; attempt += 1) {
    try {
      const issue = await repo.transition(where, 'resolved', 'human', actorRef, reason, {
        action: CLOSE_AUDIT_ACTION,
      });
      return { issue, closed: true };
    } catch (error) {
      if (
        !(error instanceof ConcurrentModificationError) &&
        !(error instanceof InvalidIssueTransitionError)
      ) {
        throw error;
      }
      // Someone moved the issue between the read and the write — either the write lost the race
      // (`ConcurrentModificationError`) or its own read already saw the new state and the graph
      // refused. If they closed it, that is the outcome this request wanted.
      const now = await repo.findById(where);
      if (now?.state === 'resolved') return { issue: now, closed: false };
      const stateUntouched = now?.state === initial.state;
      if (
        error instanceof ConcurrentModificationError &&
        stateUntouched &&
        attempt < MAX_CLOSE_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
  }
}
