import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The SIGUSR2-dump-and-read cycle end to end (012 T048, FR-024), against a real spawned OS
 * process rather than a full Docker container — the task's own explicit preference: Docker on
 * this shared machine has been a major source of multi-hour delays this session
 * (`apps/runner/runner-image.e2e.test.ts`'s own doc comment), and nothing about signal delivery or
 * file-system writes here depends on the container boundary `runner-image.e2e.test.ts` exists to
 * prove — only `apps/runner/src/main.ts`'s own signal-handling logic, which a plain child process
 * exercises identically. No mocked network is needed either: the process is pointed at an
 * unreachable control-plane URL so every heartbeat fails fast, proving the dump works with a
 * process that has never had a successful heartbeat, not just a happy-path one.
 *
 * Builds `apps/runner/dist/main.js` itself in `beforeAll` (same self-contained-build precedent as
 * `runner-image.e2e.test.ts`'s own `docker build` and `scripts/runner-build.e2e.test.ts`) so this
 * test does not depend on an earlier `pnpm run build`/`typecheck` having already run in this
 * process — `tsc --build`'s incremental cache makes a second build here fast when one already has.
 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNNER_ENTRY = join(REPO_ROOT, 'apps/runner/dist/main.js');

// A non-blocking, real-`await` poll — not a blocking `execFileSync('sleep', ...)` loop. This
// matters here specifically because one caller below polls `child.exitCode`/`child.signalCode`,
// state Node only updates once its own event loop processes the spawned child's exit — which a
// synchronous, blocking wait (this repo's Docker-backed e2e tests use exactly that, polling
// *external* `docker inspect` state instead) would never give the event loop a chance to do.
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

describe('SIGUSR2 diagnostics dump (012 T048) — a plain spawned process, no Docker', () => {
  let diagnosticsDir: string;
  let child: ChildProcess | undefined;

  beforeAll(() => {
    execFileSync('pnpm', ['exec', 'tsc', '--build', 'apps/runner/tsconfig.json'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  });

  afterAll(() => {
    if (child && child.pid !== undefined && !child.killed) {
      child.kill('SIGKILL');
    }
    if (diagnosticsDir) rmSync(diagnosticsDir, { recursive: true, force: true });
  });

  it('writes a pidfile at startup and a support diagnostic bundle on SIGUSR2', async () => {
    diagnosticsDir = mkdtempSync(join(tmpdir(), 'healer-runner-diagnostics-e2e-'));
    const pidFilePath = join(diagnosticsDir, 'healer-runner.pid');
    const dumpFilePath = join(diagnosticsDir, 'healer-runner-diagnostics.json');

    child = spawn('node', [RUNNER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LOG_LEVEL: 'fatal',
        // Unreachable on purpose — this test proves the dump works even with zero successful
        // heartbeats, and needs no mocked control plane to do it.
        RUNNER_CONTROL_PLANE_URL: 'http://127.0.0.1:1',
        RUNNER_TENANT_ID: 'tenant-e2e',
        RUNNER_NAME: 'runner-e2e',
        RUNNER_IMAGE_VERSION: '0.0.0-e2e',
        RUNNER_HEARTBEAT_INTERVAL_MS: '32000',
        RUNNER_DIAGNOSTICS_DIR: diagnosticsDir,
      },
      stdio: 'ignore',
    });

    const pidfileWritten = await waitFor(() => existsSync(pidFilePath), 10_000);
    expect(pidfileWritten).toBe(true);
    const pid = Number.parseInt(readFileSync(pidFilePath, 'utf8').trim(), 10);
    expect(pid).toBe(child.pid);

    // The very first heartbeat tick fires immediately on start() and fails fast against the
    // unreachable control plane (connection refused, near-instant on localhost) — a short fixed
    // pause here, not a poll, so the dump asserted below is proven non-trivial (at least one
    // recorded failure), not just structurally present.
    await sleep(500);

    process.kill(pid, 'SIGUSR2');
    const dumped = await waitFor(() => existsSync(dumpFilePath), 10_000);
    expect(dumped).toBe(true);

    const bundle = JSON.parse(readFileSync(dumpFilePath, 'utf8')) as {
      versions: { imageVersion: string; protocolVersion: number };
      capabilities: string[];
      configuration: Record<string, 'set' | 'default'>;
      queueDepths: { directiveSeenSet: number };
      errorSignatures: Record<string, number>;
      recentExchanges: { schema: string; byteSize: number }[];
    };

    expect(bundle.versions.imageVersion).toBe('0.0.0-e2e');
    expect(bundle.versions.protocolVersion).toBe(1);
    expect(bundle.capabilities).toEqual([]);
    expect(bundle.configuration.RUNNER_NAME).toBe('set');
    expect(bundle.configuration.RUNNER_CPU_LIMIT).toBe('default');
    expect(bundle.queueDepths).toEqual({ directiveSeenSet: 0 });
    // The unreachable control plane must have failed at least the first heartbeat by now —
    // a real, non-fabricated fact, not an empty bundle that would pass vacuously.
    expect(Object.keys(bundle.errorSignatures).length).toBeGreaterThan(0);
    expect(bundle.recentExchanges.length).toBeGreaterThan(0);
    // No config value, no URL, no raw error text anywhere in the file.
    const raw = readFileSync(dumpFilePath, 'utf8');
    expect(raw).not.toContain('tenant-e2e');
    expect(raw).not.toContain('127.0.0.1');

    child.kill('SIGTERM');
    const exited = await waitFor(
      () => child?.exitCode !== null || child?.signalCode !== null,
      10_000,
    );
    expect(exited).toBe(true);
  }, 30_000);
});
