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
  computeHeartbeatTimeoutMs,
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
  /** Stops scheduling new heartbeat ticks and resolves once any tick already in flight has
   *  settled (FR-019 "drain current tasks" — see the doc comment above `start`). */
  readonly close: () => Promise<void>;
}

/** Extra time `close()` allows beyond `sendHeartbeat`'s own abort timeout, so the rest of a cycle
 *  already past the network call (JSON parsing, directive dispatch) has a chance to finish too. */
const DRAIN_SAFETY_MARGIN_MS = 2_000;

export function start(): RunnerHandle {
  const config = loadRunnerConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, serviceName: 'healer-runner' });
  const seen = new BoundedSeenSet(config.RUNNER_DIRECTIVE_SEEN_SET_SIZE);
  const handle = createLoggingDirectiveHandler(logger);

  // Derived from `sendHeartbeat`'s own abort timeout for *this* config, not a fixed constant
  // (012 T050 review): a fixed 10s bound was actually *shorter* than the default heartbeat
  // interval's own 15s abort timeout, so `close()` could give up and let the process exit before
  // an in-flight request even reached its own timeout — not a real drain at the default setting.
  // `loadRunnerConfig` caps RUNNER_HEARTBEAT_INTERVAL_MS at 32_000ms specifically so this can
  // never exceed docker-compose.runner.yml's 20s stop_grace_period with margin to spare —
  // the cap and the grace period must be changed together (packages/shared/src/config/index.ts).
  const drainTimeoutMs =
    computeHeartbeatTimeoutMs(config.RUNNER_HEARTBEAT_INTERVAL_MS) + DRAIN_SAFETY_MARGIN_MS;

  // Tracks the currently in-flight tick (if any) so `close()` can await it instead of cutting it
  // off mid-request — a heartbeat cycle is a single outbound POST (sub-second in practice), but
  // "drain in-flight work" (FR-019) means finishing it, not abandoning it because the process is
  // about to exit (review-flagged gap: the previous `close()` was an immediate `clearInterval`
  // with no drain at all, same shape as the earlier `OutboundBuffer`-silently-losing-directives bug).
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    inFlight = withCorrelation(newCorrelationId(), () =>
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

  return {
    close: async () => {
      clearInterval(interval); // no new tick starts after this
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs));
      await Promise.race([inFlight, timeout]);
    },
  };
}

if (process.argv[1]?.endsWith('main.js')) {
  const handle = start();
  const stop = (): void => {
    void handle.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
