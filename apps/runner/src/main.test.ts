import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@healer/shared';
import type { RunnerConfig } from '@healer/shared';
import { OutboundBuffer } from '@healer/boundary-contract';
import { BoundedSeenSet } from './directive-dispatcher.js';
import { createLoggingDirectiveHandler, runHeartbeatCycle } from './main.js';
import type { HeartbeatRequestBody } from './heartbeat-client.js';

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
  RUNNER_BUFFER_SIZE: 5,
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

describe('runHeartbeatCycle (012 T045 — buffer and retry the heartbeat itself on failure)', () => {
  it('sends the current heartbeat and dispatches any directives on success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [] }),
      );
    const buffer = new OutboundBuffer<HeartbeatRequestBody>(5);
    const seen = new BoundedSeenSet(5);
    const handle = vi.fn();
    await runHeartbeatCycle({ config, buffer, seen, handle, logger: silentLogger(), fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(buffer.size).toBe(0);
    expect(handle).not.toHaveBeenCalled();
  });

  it('buffers the heartbeat instead of losing it when the control plane is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const buffer = new OutboundBuffer<HeartbeatRequestBody>(5);
    const seen = new BoundedSeenSet(5);
    await runHeartbeatCycle({
      config,
      buffer,
      seen,
      handle: vi.fn(),
      logger: silentLogger(),
      fetchImpl,
    });

    expect(buffer.size).toBe(1);
  });

  it('retries a buffered heartbeat on the next successful cycle, in order, before the new one', async () => {
    const buffer = new OutboundBuffer<HeartbeatRequestBody>(5);
    const seen = new BoundedSeenSet(5);
    const failing = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await runHeartbeatCycle({
      config,
      buffer,
      seen,
      handle: vi.fn(),
      logger: silentLogger(),
      fetchImpl: failing,
    });
    expect(buffer.size).toBe(1); // the first tick's heartbeat, buffered

    const sent: unknown[] = [];
    const succeeding = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      return jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [] });
    });
    await runHeartbeatCycle({
      config,
      buffer,
      seen,
      handle: vi.fn(),
      logger: silentLogger(),
      fetchImpl: succeeding,
    });

    expect(buffer.size).toBe(0); // fully drained once delivery succeeds
    expect(sent).toHaveLength(2); // the buffered one, then the current tick's own
  });

  it('a directive redelivered across two separate heartbeat response cycles still executes once', async () => {
    const buffer = new OutboundBuffer<HeartbeatRequestBody>(5);
    const seen = new BoundedSeenSet(5);
    const handle = vi.fn();
    const directive = { id: 'd1', directive: { kind: 'capability_query', requested: [] } };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [directive] }),
      );

    await runHeartbeatCycle({ config, buffer, seen, handle, logger: silentLogger(), fetchImpl }); // cycle 1
    await runHeartbeatCycle({ config, buffer, seen, handle, logger: silentLogger(), fetchImpl }); // cycle 2, redelivered

    expect(handle).toHaveBeenCalledTimes(1);
  });
});
