import type { HandshakeStatus } from './handshake.js';

/**
 * A registered runner's current state (012 T042, FR-018, FR-020) — the pure shape `runner_
 * registration` persists. `status` adds `revoked` to `HandshakeStatus` (an admin action, not a
 * handshake outcome; no path in this feature sets it).
 */
export interface RunnerRegistrationSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly protocolVersion: number;
  readonly capabilities: readonly string[];
  readonly imageVersion: string;
  readonly status: HandshakeStatus | 'revoked';
  readonly lastHeartbeatAt: Date;
  readonly refusedReason?: string;
}

/**
 * Placeholder pending real tuning, same status as `STALE_WINDOW_MS`/`REOPEN_WINDOW_MS` in 001 —
 * no fleet of real runners exists yet to measure a heartbeat interval against.
 */
export const HEARTBEAT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * FR-020's other half: "absence of heartbeats beyond a threshold MUST mark the capability
 * unavailable" — the decision only, mirroring `packages/workflow/periodic-checks.ts`'s
 * `findStuckRuns`. Enumerating real `runner_registration` rows and scheduling the tick is a
 * repository/scheduler concern that does not exist in any app yet (same gap `periodic-checks.ts`
 * itself names) — this is what that scheduler will call once it does, not a second copy of the
 * query. `refused`/`revoked` runners are excluded: they are already shown as unavailable, so a
 * stale heartbeat on top of that would report nothing new.
 */
export function findStaleRunners(
  runners: readonly RunnerRegistrationSnapshot[],
  now: Date,
  thresholdMs: number = HEARTBEAT_STALE_THRESHOLD_MS,
): RunnerRegistrationSnapshot[] {
  return runners.filter(
    (runner) =>
      (runner.status === 'active' || runner.status === 'degraded') &&
      now.getTime() - runner.lastHeartbeatAt.getTime() > thresholdMs,
  );
}
