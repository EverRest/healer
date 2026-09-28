import { NotFoundError, scope, type TenantContext } from '@healer/shared';
import type { Issue } from '../../domain/issue.js';
import type { IssueRepository } from '../../domain/repository.js';
import {
  ConcurrentModificationError,
  InvalidIssueTransitionError,
} from '../../domain/state-machine.js';

/**
 * The staleness window (001 T051, FR-017, R-11). `docs/stage-0.md` S0-7 lists 001's "stale window"
 * as deliberately unset pending S0-1's incident-cadence data — 30 days is a placeholder, the same
 * treatment `REOPEN_WINDOW_MS` (001 T022) already has, and belongs behind per-tenant configuration
 * once that exists rather than in this constant.
 */
export const STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The only two repository methods the sweep can call. Narrower than `IssueRepository` on purpose:
 * `transition` is not in this type, so "the sweep can never resolve an issue" (R-11) is something
 * the compiler enforces, not a convention a later edit could quietly break.
 */
export type StalenessRepository = Pick<IssueRepository, 'findStaleCandidates' | 'markStale'>;

export interface StaleSweepResult {
  readonly marked: readonly Issue[];
  /** Candidates that stopped being candidates between being read and being marked. */
  readonly skipped: number;
}

/**
 * Between the read and the write, a candidate can legitimately stop being one — a signal arrived
 * (`ConcurrentModificationError`), it was resolved or merged meanwhile
 * (`InvalidIssueTransitionError`: `resolved -> stale` is not a declared edge), or it was deleted
 * (`NotFoundError`). That is the sweep working, not failing: skip it, count it, keep going.
 */
function noLongerACandidate(error: unknown): boolean {
  return (
    error instanceof ConcurrentModificationError ||
    error instanceof InvalidIssueTransitionError ||
    error instanceof NotFoundError
  );
}

/**
 * The staleness sweep (001 T051, FR-017, R-11): marks every issue with neither a new signal nor a
 * state change inside the window, and **surfaces** it — `state` becomes `stale` and `IssueStale`
 * reaches the dashboard through the outbox. It never resolves anything. "Stopped happening" and
 * "was fixed" are different facts, and only the second belongs in the history the diagnosis engine
 * reads later.
 *
 * Runs per tenant, taking a `TenantContext` like every other read: the scheduler enumerates
 * tenants, so no query here is cross-tenant (FR-015). Idempotent — a second run finds nothing,
 * because `findStaleCandidates` excludes issues that are already stale.
 *
 * Any failure that is *not* "no longer a candidate" is collected rather than thrown on the spot,
 * and the rest of the candidates are still marked: one issue that fails deterministically must not
 * block every issue behind it on every run. The job then fails with all of them at the end
 * (`AggregateError`), so it is still a dead letter an operator sees — never a green job that
 * marked nothing. Whatever was marked before the failure stays marked, and a retry is safe.
 */
export async function markStaleIssues(
  repo: StalenessRepository,
  context: TenantContext,
  now: Date,
): Promise<StaleSweepResult> {
  const candidates = await repo.findStaleCandidates(
    scope(context, { idleBefore: new Date(now.getTime() - STALE_WINDOW_MS) }),
  );
  const marked: Issue[] = [];
  const failures: unknown[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    try {
      marked.push(
        await repo.markStale(
          scope(context, { id: candidate.id, at: now, lastProgressAt: candidate.lastProgressAt }),
        ),
      );
    } catch (error) {
      if (noLongerACandidate(error)) skipped += 1;
      else failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `staleness sweep: ${failures.length} of ${candidates.length} candidates failed (${marked.length} marked, ${skipped} skipped)`,
    );
  }
  return { marked, skipped };
}
