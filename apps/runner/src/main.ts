import {
  createLogger,
  loadRunnerConfig,
  newCorrelationId,
  withCorrelation,
  type RunnerConfig,
} from '@healer/shared';
import type { ControlPlaneDirective } from '@healer/boundary-contract';
import {
  buildHeartbeatPayload,
  sendHeartbeat,
  type HeartbeatResponse,
} from './heartbeat-client.js';
import {
  BoundedSeenSet,
  dispatchDirectives,
  type DirectiveHandler,
} from './directive-dispatcher.js';

type Logger = ReturnType<typeof createLogger>;

/**
 * The runner process (012 T045, T051). Outbound-only by construction: every call this file makes
 * is a `fetch(...)` the runner initiates (`sendHeartbeat`); nothing here binds a port, calls
 * `.listen()`, or accepts a connection — there is no code path left for the customer's network to
 * connect into (contracts/runner-protocol.md "Direction and initiation").
 *
 * `loadRunnerConfig()` is called inside `start()`, not at module load, for the same reason
 * `apps/worker/src/main.ts` defers `loadConfig()` — a test supplies its own environment after this
 * module is already imported.
 */

/**
 * No real directive-consuming logic exists yet (T093 and beyond) — this just proves a directive
 * was received and dispatched, via Pino (never `console`, backend-nestjs.md). A real handler per
 * `ControlPlaneDirective` kind is later tasks' territory (QUESTIONS.md "012 phase 6").
 */
export function createLoggingDirectiveHandler(logger: Logger): DirectiveHandler {
  return (directive: ControlPlaneDirective) => {
    logger.info({ directiveKind: directive.kind }, 'directive received');
  };
}

export interface HeartbeatCycleDeps {
  readonly config: RunnerConfig;
  readonly seen: BoundedSeenSet;
  readonly handle: DirectiveHandler;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Logs a non-`active` handshake status (FR-018, FR-020, "the runner is a product we debug it
 * blind" — this US's own headline). The control plane can reply `degraded`/`refused` with a plain
 * HTTP 200; nothing about the transport itself fails, so nothing would otherwise ever say so
 * (review finding: the runner was heartbeating "successfully" forever while doing nothing useful).
 */
function logNonActiveStatus(response: HeartbeatResponse, logger: Logger): void {
  if (response.status === 'active') return;
  const fields = {
    status: response.status,
    refusedReason: response.refusedReason,
    resolvedCapabilities: response.resolvedCapabilities,
  };
  if (response.status === 'refused') {
    logger.error(fields, 'control plane refused this runner');
  } else {
    logger.warn(fields, 'control plane degraded this runner');
  }
}

/**
 * One heartbeat tick. A heartbeat is a pure liveness signal built fresh from static config on
 * every call (`buildHeartbeatPayload` reads nothing but `config`) — replaying a stale one after an
 * outage would just be a byte-identical duplicate stamping a new `lastHeartbeatAt`, not a recovered
 * delivery of anything. So, unlike evidence submission (FR-021's actual subject —
 * `OutboundBuffer` stays reserved for that, once a receiving endpoint exists), a failed heartbeat
 * is not buffered: this tick logs and gives up, and the next interval tries again with a fresh
 * heartbeat of its own (review finding: the buffer bought nothing here but up to 50 redundant
 * identical POSTs after an outage, and a real bug — only the *last* drained response's directives
 * were ever dispatched, silently losing every directive from every other buffered response).
 *
 * Directives are dispatched unconditionally on every successful response, not just some of them.
 */
export async function runHeartbeatCycle(deps: HeartbeatCycleDeps): Promise<void> {
  const { config, seen, handle, logger, fetchImpl } = deps;
  let response: HeartbeatResponse;
  try {
    response = await sendHeartbeat(config, buildHeartbeatPayload(config), fetchImpl);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'heartbeat POST failed — will retry on the next interval',
    );
    return;
  }
  logNonActiveStatus(response, logger);
  await dispatchDirectives(response.directives, seen, handle, logger);
}

export interface RunnerHandle {
  readonly close: () => void;
}

export function start(): RunnerHandle {
  const config = loadRunnerConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, serviceName: 'healer-runner' });
  const seen = new BoundedSeenSet(config.RUNNER_DIRECTIVE_SEEN_SET_SIZE);
  const handle = createLoggingDirectiveHandler(logger);

  const tick = (): void => {
    void withCorrelation(newCorrelationId(), () =>
      runHeartbeatCycle({ config, seen, handle, logger }),
    ).catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'heartbeat tick failed unexpectedly',
      );
    });
  };

  tick();
  const interval = setInterval(tick, config.RUNNER_HEARTBEAT_INTERVAL_MS);

  return { close: () => clearInterval(interval) };
}

if (process.argv[1]?.endsWith('main.js')) {
  const handle = start();
  const stop = (): void => {
    handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
