import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runnerBuild } from './runner-build.mjs';

/**
 * `make runner-build`'s refuse-rebuild-in-place guarantee, end to end (012 T049, FR-017, ADR
 * 0014): real `docker build` calls against this repo's real apps/runner/Dockerfile, not a mocked
 * digest comparison — the unit test in runner-build.test.ts already covers
 * `assertNotRebuildInPlace`'s decision logic in isolation; this proves the whole pipeline (build →
 * inspect → compare → tag-or-refuse → stamp) actually behaves that way against real Docker.
 *
 * Three real image builds (heavier than the rest of the suite once layer caches are warm, and
 * genuinely slow on a cold cache) — listed in vitest.config.ts's `HEAVY_E2E`, same mechanism
 * `ingest-signal.e2e.test.ts` and friends already use, not a second one invented for this file.
 *
 * Observed benign noise: Vitest sometimes logs an "[vitest-worker]: Timeout calling onTaskUpdate"
 * unhandled error after this test passes — its own worker-heartbeat RPC timing out during the long
 * synchronous `execFileSync` calls below, which block the event loop for real docker builds. It
 * does not affect the test's own pass/fail result; confirmed by re-running this file in isolation.
 *
 * Mutates a real source file (apps/runner/src/index.ts) for the middle build so the second build
 * produces a different image digest than the first — always restored in `finally`/`afterAll` even
 * if an assertion throws, since this repo's own source tree is the mutation target.
 */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MUTATED_FILE = join(REPO_ROOT, 'apps/runner/src/index.ts');
const originalSource = readFileSync(MUTATED_FILE, 'utf8');

const VERSION_A = '0.0.0-e2e-refuse-test';
const VERSION_B = '0.0.0-e2e-refuse-test-2';
const scratchDir = mkdtempSync(join(tmpdir(), 'runner-build-e2e-'));

function removeTag(tag: string) {
  try {
    execFileSync('docker', ['rmi', tag], { stdio: 'ignore' });
  } catch {
    // already gone — fine
  }
}

afterAll(() => {
  writeFileSync(MUTATED_FILE, originalSource);
  removeTag(`healer-runner:${VERSION_A}`);
  removeTag(`healer-runner:${VERSION_B}`);
  rmSync(scratchDir, { recursive: true, force: true });
}, 30_000);

describe('runner-build: refuses to rebuild a published tag in place (012 T049, FR-017)', () => {
  it('builds, refuses an in-place rebuild after a source change, and succeeds once the version bumps', () => {
    const stampPathA = join(scratchDir, 'release-a.json');
    const first = runnerBuild(VERSION_A, { repoRoot: REPO_ROOT, stampPath: stampPathA });
    expect(first.tag).toBe(`healer-runner:${VERSION_A}`);
    expect(JSON.parse(readFileSync(stampPathA, 'utf8'))).toEqual({
      version: VERSION_A,
      digest: first.digest,
    });

    // Change something the build actually compiles into apps/runner/dist, so the rebuilt image's
    // digest genuinely differs — not a synthetic digest comparison. A trailing *comment* would not
    // do this: `tsc` strips comments from emitted JS by default, so a comment-only edit can
    // reproduce a byte-identical dist/index.js and, with it, the same image digest — this appends
    // a real exported binding instead, guaranteed to change the compiled output.
    writeFileSync(
      MUTATED_FILE,
      `${originalSource}\nexport const __E2E_MUTATION_MARKER__ = ${Date.now()};\n`,
    );

    const stampPathRefused = join(scratchDir, 'release-refused.json');
    expect(() =>
      runnerBuild(VERSION_A, { repoRoot: REPO_ROOT, stampPath: stampPathRefused }),
    ).toThrow(/refusing to rebuild in place/);

    // The refusal must not have moved the original tag or written a stamp for the refused build.
    const stillOriginal = execFileSync(
      'docker',
      ['image', 'inspect', '--format={{.Id}}', `healer-runner:${VERSION_A}`],
      { encoding: 'utf8' },
    ).trim();
    expect(stillOriginal).toBe(first.digest);
    expect(() => readFileSync(stampPathRefused, 'utf8')).toThrow();

    // A version bump is a legitimate new artifact — same mutated source, different tag, succeeds.
    const stampPathB = join(scratchDir, 'release-b.json');
    const second = runnerBuild(VERSION_B, { repoRoot: REPO_ROOT, stampPath: stampPathB });
    expect(second.tag).toBe(`healer-runner:${VERSION_B}`);
    expect(second.digest).not.toBe(first.digest);
    expect(JSON.parse(readFileSync(stampPathB, 'utf8'))).toEqual({
      version: VERSION_B,
      digest: second.digest,
    });
    // Three real `docker build` invocations, and this machine also runs other Docker workloads
    // concurrently (the environment's own caveat) — a shared build-cache eviction from an unrelated
    // process can force a full cold rebuild mid-test. 600s (Bash's own maximum single-command
    // timeout) gives real headroom over the ~50-90s a single cold build takes in isolation.
  }, 600_000);
});
