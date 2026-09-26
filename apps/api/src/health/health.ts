/**
 * The single source every version check reads (012 T017): the About surface, the runner
 * handshake and an operator's first question all resolve here. A second place that reports
 * a version is a second place that disagrees with the first.
 */
export type DependencyState = 'up' | 'down' | 'degraded';

export interface DependencyReport {
  readonly name: 'postgres' | 'redis';
  readonly state: DependencyState;
  /** Why, when it is not `up`. Never a connection string and never a credential. */
  readonly detail?: string;
}

export interface HealthReport {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly service: string;
  readonly version: string;
  readonly build: string;
  readonly runnerProtocolVersion: number;
  readonly dependencies: readonly DependencyReport[];
}

/**
 * `/health` is liveness — the process answers. `/ready` is readiness, and it is **down when
 * any dependency is down**: a process that accepts work it cannot complete produces failed
 * investigations rather than a clear outage.
 */
export function buildHealthReport(input: {
  service: string;
  version: string;
  build: string;
  runnerProtocolVersion: number;
  dependencies: readonly DependencyReport[];
}): HealthReport {
  const states = input.dependencies.map((d) => d.state);
  const status: HealthReport['status'] = states.includes('down')
    ? 'down'
    : states.includes('degraded')
      ? 'degraded'
      : 'ok';
  return { ...input, status };
}
