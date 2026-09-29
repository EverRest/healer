import {
  createLogger,
  loadRunnerConfig,
  newCorrelationId,
  withCorrelation,
  type RunnerConfig,
} from '@healer/shared';
import { OutboundBuffer, type ControlPlaneDirective } from '@healer/boundary-contract';
import {
  buildHeartbeatPayload,
  sendHeartbeat,
  type HeartbeatRequestBody,
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
  readonly buffer: OutboundBuffer<HeartbeatRequestBody>;
  readonly seen: BoundedSeenSet;
  readonly handle: DirectiveHandler;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
}

function describeHeartbeat(item: HeartbeatRequestBody): string {
  return `heartbeat (${item.name}, protocol ${item.protocolVersion})`;
}

/**
 * One heartbeat tick (FR-021 applied to the heartbeat itself, per QUESTIONS.md "012 phase 6"):
 * flush anything buffered from a past failed attempt first, then send this cycle's own heartbeat —
 * both in order, on the same connection attempt. The first POST that fails re-buffers itself and
 * every payload still waiting behind it, oldest-first, exactly `OutboundBuffer`'s own drop-oldest
 * policy. Heartbeats are naturally idempotent (T042's upsert is keyed by `(tenantId, name)`), so
 * redelivering a stale buffered one on reconnect is safe — no new idempotency machinery needed
 * here, unlike directive execution below.
 */
export async function runHeartbeatCycle(deps: HeartbeatCycleDeps): Promise<void> {
  const { config, buffer, seen, handle, logger, fetchImpl } = deps;
  const pending = [...buffer.drain(), buildHeartbeatPayload(config)];

  for (let index = 0; index < pending.length; index++) {
    const item = pending[index];
    if (item === undefined) continue;
    let response;
    try {
      response = await sendHeartbeat(config, item, fetchImpl);
    } catch (error) {
      for (const remaining of pending.slice(index)) buffer.push(remaining, describeHeartbeat);
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          buffered: buffer.size,
        },
        'heartbeat POST failed — buffered for retry on reconnect',
      );
      for (const gap of buffer.drainGaps()) {
        logger.warn({ gap }, 'outbound heartbeat buffer overflow — oldest heartbeat dropped');
      }
      return;
    }
    if (index === pending.length - 1) {
      await dispatchDirectives(response.directives, seen, handle);
    }
  }
}

export interface RunnerHandle {
  readonly close: () => void;
}

export function start(): RunnerHandle {
  const config = loadRunnerConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, serviceName: 'healer-runner' });
  const buffer = new OutboundBuffer<HeartbeatRequestBody>(config.RUNNER_BUFFER_SIZE);
  const seen = new BoundedSeenSet(config.RUNNER_BUFFER_SIZE);
  const handle = createLoggingDirectiveHandler(logger);

  const tick = (): void => {
    void withCorrelation(newCorrelationId(), () =>
      runHeartbeatCycle({ config, buffer, seen, handle, logger }),
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
