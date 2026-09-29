import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@healer/shared';
import type { RunnerConfig } from '@healer/shared';
import { BoundedSeenSet } from './directive-dispatcher.js';
import { createLoggingDirectiveHandler, runHeartbeatCycle } from './main.js';

const config: RunnerConfig = Object.freeze({
  LOG_LEVEL: 'info',
  RUNNER_CONTROL_PLANE_URL: 'https://control-plane.example.com',
  RUNNER_TENANT_ID: 'tenant-1',
  RUNNER_NAME: 'runner-1',
  RUNNER_IMAGE_VERSION: '0.5.0',
  RUNNER_PROTOCOL_VERSION: 1,
  RUNNER_CAPABILITIES: [],
  RUNNER_CPU_LIMIT: 1,
  RUNNER_MEMORY_MB_LIMIT: 512,
  RUNNER_MAX_CONCURRENT_RUNS: 1,
  RUNNER_HEARTBEAT_INTERVAL_MS: 30_000,
  RUNNER_DIRECTIVE_SEEN_SET_SIZE: 5,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function silentLogger(): ReturnType<typeof createLogger> {
  return createLogger({ level: 'silent' });
}

describe('createLoggingDirectiveHandler (012 T051 — trivial handler, no real directive logic yet)', () => {
  it('logs receipt without throwing, for every declared directive kind', () => {
    const logger = silentLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    const handle = createLoggingDirectiveHandler(logger);
    handle({ kind: 'capability_query', requested: ['inference'] });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ directiveKind: 'capability_query' }),
      expect.any(String),
    );
  });
});

describe('runHeartbeatCycle (012 T045 — a failed heartbeat just waits for the next interval)', () => {
  it('sends the current heartbeat and does not touch the seen-set or handler when there are no directives', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [] }),
      );
    const seen = new BoundedSeenSet(5);
    const handle = vi.fn();
    await runHeartbeatCycle({ config, seen, handle, logger: silentLogger(), fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(handle).not.toHaveBeenCalled();
  });

  it('dispatches a real directive from a successful response', async () => {
    const directive = { id: 'd1', directive: { kind: 'capability_query' as const, requested: [] } };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [directive] }),
      );
    const seen = new BoundedSeenSet(5);
    const handle = vi.fn();
    await runHeartbeatCycle({ config, seen, handle, logger: silentLogger(), fetchImpl });

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(directive.directive);
  });

  it('does nothing but log a warning when the POST fails — no buffering, no throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const logger = silentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const handle = vi.fn();
    await expect(
      runHeartbeatCycle({ config, seen: new BoundedSeenSet(5), handle, logger, fetchImpl }),
    ).resolves.toBeUndefined();

    expect(handle).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('ECONNREFUSED') }),
      expect.any(String),
    );
  });

  it('a directive redelivered across two separate heartbeat response cycles still executes once', async () => {
    const seen = new BoundedSeenSet(5);
    const handle = vi.fn();
    const directive = { id: 'd1', directive: { kind: 'capability_query' as const, requested: [] } };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [directive] }),
      );

    await runHeartbeatCycle({ config, seen, handle, logger: silentLogger(), fetchImpl }); // cycle 1
    await runHeartbeatCycle({ config, seen, handle, logger: silentLogger(), fetchImpl }); // cycle 2, redelivered

    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('logs at warn when the control plane reports this runner degraded', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'degraded',
        resolvedCapabilities: [],
        refusedReason: undefined,
        directives: [],
      }),
    );
    const logger = silentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    await runHeartbeatCycle({
      config,
      seen: new BoundedSeenSet(5),
      handle: vi.fn(),
      logger,
      fetchImpl,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'degraded' }),
      expect.any(String),
    );
  });

  it('logs at error when the control plane refuses this runner', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'refused',
        resolvedCapabilities: [],
        refusedReason: 'protocol version too old',
        directives: [],
      }),
    );
    const logger = silentLogger();
    const errorSpy = vi.spyOn(logger, 'error');
    await runHeartbeatCycle({
      config,
      seen: new BoundedSeenSet(5),
      handle: vi.fn(),
      logger,
      fetchImpl,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'refused', refusedReason: 'protocol version too old' }),
      expect.any(String),
    );
  });

  it('never logs the non-active status handlers when the status is active', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [] }),
      );
    const logger = silentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');
    await runHeartbeatCycle({
      config,
      seen: new BoundedSeenSet(5),
      handle: vi.fn(),
      logger,
      fetchImpl,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
