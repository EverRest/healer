import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * apps/runner/Dockerfile end to end (012 T050, FR-019): builds the real image, runs a real
 * container, sends it SIGTERM, and asserts it exits cleanly within a bounded time — proving the
 * drain path this feature depends on (main.ts's `close()` awaiting any in-flight heartbeat before
 * the process exits) actually works through Docker's own signal delivery, not just in a unit test
 * that calls `close()` directly. Docker is a project assumption already (docker/docker-compose.yml,
 * testcontainers-backed e2e tests elsewhere) — this is the first test that builds an image from
 * this repo's own Dockerfile rather than pulling one.
 *
 * A full image build easily dominates this test's running time (cold: ~60-90s; warm layer cache:
 * ~10-50s) — heavier than the rest of the e2e suite, so it is listed in vitest.config.ts's
 * `HEAVY_E2E` (the same mechanism `ingest-signal.e2e.test.ts` and friends already use to avoid
 * running concurrently with the main e2e project and inflating its own wall-clock budget), not a
 * second, invented gating mechanism.
 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IMAGE = 'healer-runner-e2e-test:latest';
const CONTAINER = 'healer-runner-e2e-test-container';

function docker(args: string[]) {
  return spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

describe('apps/runner/Dockerfile — build, run, SIGTERM drain (012 T050, FR-019)', () => {
  beforeAll(() => {
    docker(['rm', '-f', CONTAINER]); // best-effort, in case a previous run left one behind
    execFileSync('docker', ['build', '-t', IMAGE, '-f', 'apps/runner/Dockerfile', '.'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  }, 180_000);

  afterAll(() => {
    docker(['rm', '-f', CONTAINER]);
    docker(['rmi', IMAGE]);
  }, 30_000);

  it('boots, resolves every module, and exits cleanly within the bounded grace period on SIGTERM', () => {
    const run = docker([
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-e',
      'RUNNER_CONTROL_PLANE_URL=http://control-plane.invalid',
      '-e',
      'RUNNER_TENANT_ID=tenant-e2e',
      '-e',
      'RUNNER_NAME=runner-e2e',
      '-e',
      'RUNNER_IMAGE_VERSION=0.0.0-e2e',
      '-e',
      'RUNNER_HEARTBEAT_INTERVAL_MS=5000',
      IMAGE,
    ]);
    expect(run.status, run.stderr).toBe(0);

    // Give the process a moment to actually start and attempt its first heartbeat — proves the
    // built image resolves every module (apps/runner/dist plus its two workspace deps) rather
    // than crash-looping on a missing dependency.
    spawnSync('sleep', ['2']);
    const logs = docker(['logs', CONTAINER]);
    expect(logs.stdout + logs.stderr).toMatch(/heartbeat POST failed/);

    const GRACE_SECONDS = 15;
    const start = Date.now();
    const stop = docker(['stop', '-t', String(GRACE_SECONDS), CONTAINER]);
    const elapsedSeconds = (Date.now() - start) / 1000;
    expect(stop.status, stop.stderr).toBe(0);

    // Comfortably under the grace period: the process exited on its own once `close()`'s drain
    // resolved, Docker never had to escalate to SIGKILL after the timeout.
    expect(elapsedSeconds).toBeLessThan(GRACE_SECONDS - 2);

    const inspect = docker(['inspect', CONTAINER, '--format={{.State.ExitCode}}']);
    expect(inspect.stdout.trim()).toBe('0');
  }, 60_000);
});
