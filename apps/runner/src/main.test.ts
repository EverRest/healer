import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@healer/shared';
import type { RunnerConfig } from '@healer/shared';
import { BoundedSeenSet } from './directive-dispatcher.js';
import { DiagnosticsState } from './diagnostics-state.js';
import { pidFilePath } from './diagnostics-paths.js';
import {
  buildRunnerDiagnosticsBundle,
  createLoggingDirectiveHandler,
  runHeartbeatCycle,
  start,
  writeDiagnosticsFile,
} from './main.js';

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
  RUNNER_DIAGNOSTICS_DIR: '/tmp',
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
    await runHeartbeatCycle({
      config,
      seen,
      handle,
      logger: silentLogger(),
      diagnostics: new DiagnosticsState(),
      fetchImpl,
    });

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
    await runHeartbeatCycle({
      config,
      seen,
      handle,
      logger: silentLogger(),
      diagnostics: new DiagnosticsState(),
      fetchImpl,
    });

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(directive.directive);
  });

  it('does nothing but log a warning when the POST fails — no buffering, no throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const logger = silentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const handle = vi.fn();
    await expect(
      runHeartbeatCycle({
        config,
        seen: new BoundedSeenSet(5),
        handle,
        logger,
        diagnostics: new DiagnosticsState(),
        fetchImpl,
      }),
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

    const diagnostics = new DiagnosticsState();
    await runHeartbeatCycle({
      config,
      seen,
      handle,
      logger: silentLogger(),
      diagnostics,
      fetchImpl,
    }); // cycle 1
    await runHeartbeatCycle({
      config,
      seen,
      handle,
      logger: silentLogger(),
      diagnostics,
      fetchImpl,
    }); // cycle 2, redelivered

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
      diagnostics: new DiagnosticsState(),
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
      diagnostics: new DiagnosticsState(),
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
      diagnostics: new DiagnosticsState(),
      fetchImpl,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('start/close — drain the in-flight heartbeat before the process exits (FR-019, review finding)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('close() does not resolve until the heartbeat POST already in flight settles', async () => {
    vi.stubEnv('LOG_LEVEL', 'fatal');
    vi.stubEnv('RUNNER_CONTROL_PLANE_URL', 'https://control-plane.example.com');
    vi.stubEnv('RUNNER_TENANT_ID', 'tenant-1');
    vi.stubEnv('RUNNER_NAME', 'runner-1');
    vi.stubEnv('RUNNER_IMAGE_VERSION', '0.5.0');
    // Long enough that the test's own close() call, not a second tick, is what's being raced —
    // 32_000ms is loadRunnerConfig's own max (012 T050 review: this value drives the drain
    // timeout, capped so it can never exceed docker-compose.runner.yml's stop_grace_period).
    vi.stubEnv('RUNNER_HEARTBEAT_INTERVAL_MS', '32000');
    const diagnosticsDir = mkdtempSync(join(tmpdir(), 'healer-runner-test-'));
    vi.stubEnv('RUNNER_DIAGNOSTICS_DIR', diagnosticsDir);

    let resolveFetch: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          pending.then(() =>
            jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [] }),
          ),
        ),
    );

    const handle = start();
    let closed = false;
    const closePromise = handle.close().then(() => {
      closed = true;
    });

    // Let the microtask queue turn over a few times — close() must still be waiting on the
    // in-flight fetch, not the immediate `clearInterval`-only behaviour this replaces.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveFetch?.();
    await closePromise;
    expect(closed).toBe(true);
    rmSync(diagnosticsDir, { recursive: true, force: true });
  });

  it('writes a pidfile containing {pid, nonce} at startup and removes it on close (012 T048 review — identity, not just liveness)', async () => {
    vi.stubEnv('LOG_LEVEL', 'fatal');
    vi.stubEnv('RUNNER_CONTROL_PLANE_URL', 'https://control-plane.example.com');
    vi.stubEnv('RUNNER_TENANT_ID', 'tenant-1');
    vi.stubEnv('RUNNER_NAME', 'runner-1');
    vi.stubEnv('RUNNER_IMAGE_VERSION', '0.5.0');
    const diagnosticsDir = mkdtempSync(join(tmpdir(), 'healer-runner-pidfile-test-'));
    vi.stubEnv('RUNNER_DIAGNOSTICS_DIR', diagnosticsDir);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [] }),
        ),
    );

    const path = pidFilePath(diagnosticsDir);
    const handle = start();
    const content = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; nonce: string };
    expect(content.pid).toBe(process.pid);
    expect(typeof content.nonce).toBe('string');
    expect(content.nonce.length).toBeGreaterThan(0);

    await handle.close();
    expect(existsSync(path)).toBe(false);
    rmSync(diagnosticsDir, { recursive: true, force: true });
  });
});

describe('runHeartbeatCycle — diagnostics instrumentation (012 T048, FR-024)', () => {
  it('records latency and both sides of the exchange as schema id + byte size on a successful cycle', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: 'active', resolvedCapabilities: [], directives: [] }),
      );
    const diagnostics = new DiagnosticsState();
    await runHeartbeatCycle({
      config,
      seen: new BoundedSeenSet(5),
      handle: vi.fn(),
      logger: silentLogger(),
      diagnostics,
      fetchImpl,
    });

    const snapshot = diagnostics.snapshot();
    expect(snapshot.recentExchanges).toEqual([
      expect.objectContaining({ schema: 'heartbeat-request' }),
      expect.objectContaining({ schema: 'heartbeat-response' }),
    ]);
    expect(snapshot.heartbeatLatencyHistogramMs.counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('records only the request side of the exchange and a normalized error signature on a failed cycle', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const diagnostics = new DiagnosticsState();
    await runHeartbeatCycle({
      config,
      seen: new BoundedSeenSet(5),
      handle: vi.fn(),
      logger: silentLogger(),
      diagnostics,
      fetchImpl,
    });

    const snapshot = diagnostics.snapshot();
    expect(snapshot.recentExchanges).toEqual([
      expect.objectContaining({ schema: 'heartbeat-request' }),
    ]);
    expect(snapshot.errorSignatures).toEqual({ 'network error': 1 });
  });
});

describe('buildRunnerDiagnosticsBundle (012 T048, FR-024)', () => {
  it('assembles versions, capabilities, config presence, queue depth and accumulated state', () => {
    const seen = new BoundedSeenSet(5);
    seen.markSeen('d1');
    const diagnostics = new DiagnosticsState();
    diagnostics.recordHeartbeatSuccess(10, 100, 200);

    const bundle = buildRunnerDiagnosticsBundle(
      config,
      { RUNNER_NAME: 'set', RUNNER_CPU_LIMIT: 'default' },
      seen,
      diagnostics,
      'nonce-xyz',
    );

    expect(bundle.versions).toEqual({ imageVersion: '0.5.0', protocolVersion: 1 });
    expect(bundle.capabilities).toEqual([]);
    expect(bundle.configuration).toEqual({ RUNNER_NAME: 'set', RUNNER_CPU_LIMIT: 'default' });
    expect(bundle.queueDepths).toEqual({ directiveSeenSet: 1 });
    expect(bundle.recentExchanges.length).toBe(2);
    expect(bundle.processNonce).toBe('nonce-xyz');
  });
});

describe('writeDiagnosticsFile (012 T048 — the file `make runner-diagnostics` reads)', () => {
  it('writes the bundle as pretty JSON, readable back byte for byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'healer-runner-diagnostics-test-'));
    const filePath = join(dir, 'nested', 'diagnostics.json');
    const bundle = buildRunnerDiagnosticsBundle(
      config,
      {},
      new BoundedSeenSet(5),
      new DiagnosticsState(),
      'nonce-file-test',
    );

    writeDiagnosticsFile(bundle, filePath);
    const readBack = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;

    expect(readBack).toEqual(bundle);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the planted-marker test (012 T048, FR-023 applied to FR-024's bundle — the single most important test in this task)", () => {
  it('never lets a marker planted in config, a thrown network error, a validation failure, or a refused response reach the diagnostics bundle', async () => {
    const MARKER = 'MARKER-3f9c1a7e-9d2b-PLANTED-VALUE';
    const markedConfig: RunnerConfig = {
      ...config,
      RUNNER_NAME: MARKER,
      RUNNER_TENANT_ID: MARKER,
      RUNNER_CONTROL_PLANE_URL: `https://control-plane.example.com/${MARKER}`,
    };
    // Presence-only, by construction — a real caller derives this via getRunnerConfigPresence,
    // which by design can never carry a value (packages/shared/src/config's own test covers that
    // half); this test's own job is the other half — everything downstream of config.
    const presence = { RUNNER_NAME: 'set' as const, RUNNER_TENANT_ID: 'set' as const };
    const seen = new BoundedSeenSet(5);
    const diagnostics = new DiagnosticsState();
    const logger = silentLogger();

    // Cycle 1: a thrown network error whose message embeds the marker.
    await runHeartbeatCycle({
      config: markedConfig,
      seen,
      handle: vi.fn(),
      logger,
      diagnostics,
      fetchImpl: vi.fn().mockRejectedValue(new Error(`ECONNREFUSED ${MARKER}`)),
    });

    // Cycle 2: a response that fails independent ingress validation, with the marker inside the
    // very value zod rejects (a real validation error message can quote a received value verbatim).
    await runHeartbeatCycle({
      config: markedConfig,
      seen,
      handle: vi.fn(),
      logger,
      diagnostics,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ status: MARKER })),
    });

    // Cycle 3: a well-formed but `refused` response — a "successful" transport call (HTTP 200) —
    // whose refusedReason carries the marker. Only its byte size may cross, never its content.
    await runHeartbeatCycle({
      config: markedConfig,
      seen,
      handle: vi.fn(),
      logger,
      diagnostics,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          status: 'refused',
          resolvedCapabilities: [],
          refusedReason: MARKER,
          directives: [],
        }),
      ),
    });

    const bundle = buildRunnerDiagnosticsBundle(
      markedConfig,
      presence,
      seen,
      diagnostics,
      'nonce-planted-marker-test',
    );
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain(MARKER);
    // Sanity: the test actually exercised all three leak-prone paths, not vacuously passing on an
    // empty bundle — an assertion with nothing recorded would prove nothing.
    expect(Object.keys(bundle.errorSignatures).length).toBeGreaterThan(0);
    expect(bundle.recentExchanges.length).toBeGreaterThan(0);
  });
});
