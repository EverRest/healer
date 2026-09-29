import { describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@healer/shared';
import {
  buildHeartbeatPayload,
  HeartbeatTransportError,
  sendHeartbeat,
} from './heartbeat-client.js';

const config: RunnerConfig = Object.freeze({
  LOG_LEVEL: 'info',
  RUNNER_CONTROL_PLANE_URL: 'https://control-plane.example.com',
  RUNNER_TENANT_ID: 'tenant-1',
  RUNNER_NAME: 'runner-1',
  RUNNER_IMAGE_VERSION: '0.5.0',
  RUNNER_PROTOCOL_VERSION: 1,
  RUNNER_CAPABILITIES: ['inference'],
  RUNNER_CPU_LIMIT: 2,
  RUNNER_MEMORY_MB_LIMIT: 1024,
  RUNNER_MAX_CONCURRENT_RUNS: 3,
  RUNNER_HEARTBEAT_INTERVAL_MS: 30_000,
  RUNNER_DIRECTIVE_SEEN_SET_SIZE: 200,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = {
  status: 'active',
  resolvedCapabilities: ['inference'],
  directives: [],
};

describe('buildHeartbeatPayload (012 T045)', () => {
  it('maps runner config to the exact wire shape apps/api/runner-heartbeat.dto.ts expects', () => {
    expect(buildHeartbeatPayload(config)).toEqual({
      name: 'runner-1',
      protocolVersion: 1,
      imageVersion: '0.5.0',
      capabilities: ['inference'],
      resourceLimits: { cpu: 2, memoryMb: 1024, maxConcurrentRuns: 3 },
    });
  });
});

describe('sendHeartbeat (012 T045 — the runner initiates, outbound only)', () => {
  it('POSTs to /runners/heartbeat with the tenant header and the built payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    const payload = buildHeartbeatPayload(config);
    const result = await sendHeartbeat(config, payload, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://control-plane.example.com/runners/heartbeat');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-tenant-id']).toBe('tenant-1');
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(result.status).toBe('active');
    expect(result.directives).toEqual([]);
  });

  it('binds an abort signal so a hung control plane cannot pile up ticks indefinitely', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await sendHeartbeat(config, buildHeartbeatPayload(config), fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts a response whose directives carry a real DirectiveEnvelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'active',
        resolvedCapabilities: [],
        directives: [{ id: 'd1', directive: { kind: 'capability_query', requested: [] } }],
      }),
    );
    const result = await sendHeartbeat(config, buildHeartbeatPayload(config), fetchImpl);
    expect(result.directives).toEqual([
      { id: 'd1', directive: { kind: 'capability_query', requested: [] } },
    ]);
  });

  it('rejects a response whose directives array carries no id — the shape both sides must agree on', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'active',
        resolvedCapabilities: [],
        directives: [{ directive: { kind: 'capability_query', requested: [] } }],
      }),
    );
    await expect(sendHeartbeat(config, buildHeartbeatPayload(config), fetchImpl)).rejects.toThrow(
      HeartbeatTransportError,
    );
  });

  it('throws HeartbeatTransportError when the network call itself fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(sendHeartbeat(config, buildHeartbeatPayload(config), fetchImpl)).rejects.toThrow(
      HeartbeatTransportError,
    );
  });

  it('throws HeartbeatTransportError on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'bad' }, 503));
    await expect(sendHeartbeat(config, buildHeartbeatPayload(config), fetchImpl)).rejects.toThrow(
      HeartbeatTransportError,
    );
  });

  it('throws HeartbeatTransportError when the response fails independent ingress validation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 'not-a-real-status' }));
    await expect(sendHeartbeat(config, buildHeartbeatPayload(config), fetchImpl)).rejects.toThrow(
      HeartbeatTransportError,
    );
  });
});
