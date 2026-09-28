import { scope, type TenantContext } from '@healer/shared';
import type { Issue } from '../../domain/issue.js';
import type { IssueRepository } from '../../domain/repository.js';
import { ConcurrentModificationError } from '../../domain/state-machine.js';

/**
 * The staleness window (001 T051, FR-017, R-11). `docs/stage-0.md` S0-7 lists 001's "stale window"
 * as deliberately unset pending S0-1's incident-cadence data — 30 days is a placeholder, the same
 * treatment `REOPEN_WINDOW_MS` (001 T022) already has, and belongs behind per-tenant configuration
 * once that exists rather than in this constant.
 */
export const STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The staleness sweep (001 T051, FR-017, R-11): marks every issue with neither a new signal nor a
 * state change inside the window, and **surfaces** it — `state` becomes `stale` and `IssueStale`
 * reaches the dashboard through the outbox. It never resolves anything. "Stopped happening" and
 * "was fixed" are different facts, and only the second belongs in the history the diagnosis engine
 * reads later, so there is no path from here to `resolved` at all — not a guard that could be
 * removed, but an absent capability: this function only ever calls `markStale`.
 *
 * Runs per tenant, taking a `TenantContext` like every other read: the scheduler enumerates
 * tenants, so no query here is cross-tenant (FR-015). Idempotent — a second run finds nothing,
 * because `findStaleCandidates` excludes issues that are already stale.
 *
 * An issue that made progress between being read and being marked throws
 * `ConcurrentModificationError` from `markStale`; that is the sweep working, not failing — it was
 * not stale after all — so it is skipped and the rest are still marked. Anything else propagates.
 */
export async function markStaleIssues(
  repo: IssueRepository,
  context: TenantContext,
  now: Date,
): Promise<readonly Issue[]> {
  const candidates = await repo.findStaleCandidates(
    scope(context, { idleBefore: new Date(now.getTime() - STALE_WINDOW_MS) }),
  );
  const marked: Issue[] = [];
  for (const candidate of candidates) {
    try {
      marked.push(
        await repo.markStale(
          scope(context, {
            id: candidate.issue.id,
            at: now,
            lastProgressAt: candidate.lastProgressAt,
          }),
        ),
      );
    } catch (error) {
      if (!(error instanceof ConcurrentModificationError)) throw error;
    }
  }
  return marked;
}
