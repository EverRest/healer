/**
 * The two periodic checks the persisted machine needs (012 T056, T058, FR-025, FR-029, data-model
 * invariant, quickstart 24/26): the decision logic only. Querying `workflow_run` for candidates
 * and scheduling the tick is a repository concern that doesn't exist in any app yet (same gap as
 * T042) — this is what that repository will call once it does, not a second copy of the query.
 */
import { isStuck, type WorkflowRun } from './machine.js';

/**
 * A callback that never arrives is still resolved by the run's own deadline, not by a worker
 * waiting on it (ADR 0003) — this is what a scheduled tick reads to know which runs to wake.
 */
export function findOverdueRuns(runs: readonly WorkflowRun[], now: Date): WorkflowRun[] {
  return runs.filter(
    (run) => !run.terminalState && run.deadlineAt !== undefined && run.deadlineAt <= now,
  );
}

/**
 * `isStuck` (machine.ts) is the per-run predicate the data-model invariant names; this is the
 * batch form a periodic check runs over every non-terminal run it can see.
 */
export function findStuckRuns(runs: readonly WorkflowRun[]): WorkflowRun[] {
  return runs.filter(isStuck);
}
