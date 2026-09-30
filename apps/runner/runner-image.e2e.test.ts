import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 *
 * SIGTERM delivery: `docker exec <container> kill -TERM 1`, not `docker stop`/`docker kill`.
 * Root-caused during 012 T050 review's re-verification: on this machine's Docker Desktop
 * (4.37.1 / Engine 27.4.0), a `docker stop`/`docker kill` sent from the SAME script process that
 * just created the container (i.e. `docker run` and the stop call both issued via
 * `child_process` in one continuous Node process, with anywhere from 1s to 8s between them)
 * reproducibly reported success but the signal never reached the container's PID 1 — confirmed
 * with `/proc/1/status` showing SIGTERM genuinely caught (`SigCgt` includes bit 14) and the
 * process still `running` 20+ minutes later, i.e. a real hang, not slowness. `docker exec
 * <container> kill -TERM 1` (entering the container's own PID namespace and using the raw `kill`
 * syscall, bypassing whatever daemon-level relay `docker stop`/`kill` uses) delivered the signal
 * instantly and correctly every time. This is a Docker Desktop signal-relay quirk specific to a
 * container signaled moments after its own creation from the same client process — not a defect
 * in apps/runner/src/main.ts, which was proven correct independently (manual, separately-invoked
 * `docker stop`/`kill` — i.e. issued as a fresh CLI invocation well after the container had been
 * running for a while — drained cleanly every time).
 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IMAGE = 'healer-runner-e2e-test:latest';
const CONTAINER = 'healer-runner-e2e-test-container';
const CONTAINER_SLOW = 'healer-runner-e2e-slow-drain-container';
const SLOW_SERVER_CONTAINER = 'healer-runner-e2e-slow-heartbeat-server';
const NETWORK = 'healer-runner-e2e-test-net';

function docker(args: string[]) {
  return spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** Polls instead of a fixed sleep — this machine also runs other Docker/network workloads
 *  concurrently (the environment's own caveat), and how long a DNS failure, a container's first
 *  log line, or its own exit takes varies with that load, not with this feature's own correctness. */
function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 250): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    spawnSync('sleep', [String(intervalMs / 1000)]);
  }
  return predicate();
}

/** See the file-level doc comment: delivers SIGTERM directly inside the container's own PID
 *  namespace rather than through `docker stop`/`docker kill`, which this Docker Desktop
 *  installation has shown can silently fail to relay the signal at all in this exact scenario. */
function sendSigterm(container: string) {
  return docker(['exec', container, 'kill', '-TERM', '1']);
}

function containerStatus(container: string): string {
  return docker(['inspect', container, '--format={{.State.Status}}']).stdout.trim();
}

/** Polls the container's own state instead of blocking inside `docker stop`'s timeout-then-SIGKILL
 *  mechanism — this test cares whether the *process* exited on its own, not how any particular CLI
 *  subcommand's own waiting behaves. */
function waitForExit(container: string, timeoutMs: number): number {
  const start = Date.now();
  waitFor(() => containerStatus(container) !== 'running', timeoutMs, 200);
  return (Date.now() - start) / 1000;
}

describe('apps/runner/Dockerfile — build, run, SIGTERM drain (012 T050, FR-019)', () => {
  beforeAll(() => {
    // Best-effort, in case a previous run left any of these behind.
    docker(['rm', '-f', CONTAINER]);
    docker(['rm', '-f', CONTAINER_SLOW]);
    docker(['rm', '-f', SLOW_SERVER_CONTAINER]);
    docker(['network', 'rm', NETWORK]);
    execFileSync('docker', ['build', '-t', IMAGE, '-f', 'apps/runner/Dockerfile', '.'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    // 300s, not the project's 180s default `hookTimeout` (vitest.config.ts): reproduced once
    // already — this build took ~185s under concurrent load from other Docker workloads on this
    // shared machine (the environment's own caveat), comfortably over the default.
  }, 300_000);

  afterAll(() => {
    docker(['rm', '-f', CONTAINER]);
    docker(['rm', '-f', CONTAINER_SLOW]);
    docker(['rm', '-f', SLOW_SERVER_CONTAINER]);
    docker(['network', 'rm', NETWORK]);
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

    // Wait for the first heartbeat's DNS failure to actually surface — proves the built image
    // resolves every module (apps/runner/dist plus its two workspace deps) rather than
    // crash-looping on a missing dependency. Polled, not a fixed sleep (012 T050 review: a flat 2s
    // assumed a near-instant DNS failure, which this machine's actual resolver did not always
    // deliver under concurrent load — a timing assumption, not a product bug).
    let logs = { stdout: '', stderr: '' };
    const sawFailure = waitFor(() => {
      logs = docker(['logs', CONTAINER]);
      return /heartbeat POST failed/.test(logs.stdout + logs.stderr);
    }, 20_000);
    expect(sawFailure, logs.stdout + logs.stderr).toBe(true);

    const sig = sendSigterm(CONTAINER);
    expect(sig.status, sig.stderr).toBe(0);
    const elapsedSeconds = waitForExit(CONTAINER, 20_000);

    // Comfortably fast: the process exited on its own once `close()`'s drain resolved. This
    // DNS-failure case resolves almost instantly, so it does NOT exercise a genuinely in-flight
    // heartbeat — that scenario has its own test below (012 T050 review).
    expect(elapsedSeconds).toBeLessThan(18);

    const inspect = docker(['inspect', CONTAINER, '--format={{.State.ExitCode}}']);
    expect(inspect.stdout.trim()).toBe('0');
  }, 60_000);

  /**
   * 012 T050 review, reproduced: the built image's shared pnpm store carried @prisma/client, the
   * prisma CLI, @prisma/engines (~33MB), typescript, supertest, @types/* and fast-check — none of
   * them reachable from apps/runner's own code, all pulled in because installing against this
   * repo's single shared workspace lockfile also populates the store with the workspace root's own
   * `dependencies` closure (see scripts/prune-runner-store.mjs's doc comment for the full account).
   * `prune-runner-store.mjs` now deletes everything the runner's real graph doesn't reach; this
   * proves it against the actual built image, not just the pruning script's own unit tests.
   */
  it('carries no Prisma tooling in its dependency closure, even unreferenced', () => {
    const listing = docker([
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      'ls node_modules/.pnpm',
    ]);
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).not.toMatch(/^(@prisma\+|prisma@)/m);
  }, 30_000);

  /**
   * The SIGTERM test above resolves its heartbeat POST (a DNS failure) almost instantly, so it
   * never actually has a request in flight when SIGTERM arrives — it cannot tell a genuine drain
   * apart from an immediate exit (012 T050 review). This runs a second, real HTTP server as a
   * Docker sidecar (container-to-container networking — reliable; `host.docker.internal` from the
   * test host was tried first and its TCP connection reached Docker Desktop's proxy but the actual
   * HTTP request never completed, a macOS/Docker-Desktop networking quirk not worth chasing when a
   * sidecar container solves it directly) that sleeps for `DELAY_MS` before responding, so the
   * runner's first heartbeat is still genuinely awaiting a response when SIGTERM is sent.
   */
  it('genuinely drains an in-flight heartbeat before exiting on SIGTERM', () => {
    const DELAY_MS = 4_000;
    const scratchDir = mkdtempSync(join(tmpdir(), 'runner-slow-server-'));
    const serverScript = join(scratchDir, 'slow-server.mjs');
    writeFileSync(
      serverScript,
      [
        "import { createServer } from 'node:http';",
        'const server = createServer((req, res) => {',
        '  setTimeout(() => {',
        "    res.writeHead(200, { 'content-type': 'application/json' });",
        "    res.end(JSON.stringify({ status: 'active', resolvedCapabilities: [], directives: [] }));",
        `  }, ${DELAY_MS});`,
        '});',
        "server.listen(8080, '0.0.0.0');",
      ].join('\n'),
    );

    try {
      const netCreate = docker(['network', 'create', NETWORK]);
      expect(netCreate.status, netCreate.stderr).toBe(0);

      const slowServer = docker([
        'run',
        '-d',
        '--name',
        SLOW_SERVER_CONTAINER,
        '--network',
        NETWORK,
        '-v',
        `${serverScript}:/slow-server.mjs:ro`,
        'node:22-alpine',
        'node',
        '/slow-server.mjs',
      ]);
      expect(slowServer.status, slowServer.stderr).toBe(0);
      // Poll until the sidecar is actually reachable, not a fixed sleep (012 T050 review — the
      // same load-dependent flakiness as test 1 above): if the runner's first tick fires before
      // the sidecar is really listening, that request fails immediately instead of genuinely
      // hanging for DELAY_MS, and the next tick would not fire for another
      // RUNNER_HEARTBEAT_INTERVAL_MS, well past this test's own window.
      const sidecarReady = waitFor(() => {
        const probe = docker([
          'run',
          '--rm',
          '--network',
          NETWORK,
          'curlimages/curl:latest',
          '-s',
          '-o',
          '/dev/null',
          '--connect-timeout',
          '1',
          '--max-time',
          '2',
          `http://${SLOW_SERVER_CONTAINER}:8080/`,
        ]);
        // curl exit 7 = connection refused (server not listening yet) — the only outcome that
        // means "not ready". The sidecar intentionally never responds before DELAY_MS, so a
        // *successful connect* that then times out waiting for the body (exit 28) still means
        // "ready": the TCP handshake itself already proved the server is up.
        return probe.status !== 7;
      }, 15_000);
      expect(sidecarReady).toBe(true);

      const run = docker([
        'run',
        '-d',
        '--name',
        CONTAINER_SLOW,
        '--network',
        NETWORK,
        '-e',
        `RUNNER_CONTROL_PLANE_URL=http://${SLOW_SERVER_CONTAINER}:8080`,
        '-e',
        'RUNNER_TENANT_ID=tenant-e2e',
        '-e',
        'RUNNER_NAME=runner-e2e-slow',
        '-e',
        'RUNNER_IMAGE_VERSION=0.0.0-e2e',
        // One tick, comfortably longer than this test — the second tick must never fire.
        // 32_000ms is loadRunnerConfig's own max (012 T050 review: it caps the interval so the
        // drain timeout it drives can never exceed docker-compose.runner.yml's stop_grace_period).
        '-e',
        'RUNNER_HEARTBEAT_INTERVAL_MS=32000',
        IMAGE,
      ]);
      expect(run.status, run.stderr).toBe(0);

      // Let the runner's first tick actually reach the slow server and start waiting on its
      // response — genuinely in flight, not merely sent-and-still-in-the-TCP-stack.
      spawnSync('sleep', ['1']);

      const sig = sendSigterm(CONTAINER_SLOW);
      expect(sig.status, sig.stderr).toBe(0);
      // 90s, not the DELAY_MS=4s+drain-margin math's own ~6s expectation: reproduced twice on this
      // shared machine under concurrent Docker/host load (elapsed landed at 40.1s once, above the
      // previous 40s poll ceiling itself the second time) — this bound exists to catch a genuine
      // hang, not to assert precise timing, so it stays generous rather than fragile under
      // contention this environment has repeatedly shown it doesn't control.
      const elapsedSeconds = waitForExit(CONTAINER_SLOW, 90_000);

      // An immediate exit (the pre-fix, un-drained `close()`) would show well under a second here.
      // A genuine drain waits for the in-flight request to actually settle — and still comfortably
      // bounded, proving this isn't a hang either. The upper bound is intentionally loose (see the
      // comment above `waitForExit`'s own timeout) — it exists to rule out "never exits", not to
      // pin down exact drain latency, which this shared host cannot promise.
      expect(elapsedSeconds).toBeGreaterThan(2);
      expect(elapsedSeconds).toBeLessThan(80);

      const inspect = docker(['inspect', CONTAINER_SLOW, '--format={{.State.ExitCode}}']);
      expect(inspect.stdout.trim()).toBe('0');
    } finally {
      docker(['rm', '-f', CONTAINER_SLOW]);
      docker(['rm', '-f', SLOW_SERVER_CONTAINER]);
      docker(['network', 'rm', NETWORK]);
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }, 150_000);
});
