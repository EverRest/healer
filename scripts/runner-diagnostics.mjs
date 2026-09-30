#!/usr/bin/env node
// `make runner-diagnostics` (012 T048, FR-024, contracts/runner-protocol.md's Diagnostics (R-06)
// section): signals a running runner process with SIGUSR2 and prints the support diagnostic
// bundle it dumps to disk in response (apps/runner/src/main.ts's own SIGUSR2 handler).
//
// The runner is outbound-only by construction (T045) and exposes no admin endpoint, even for
// this — so this script cannot discover or query a runner over the network. It finds one purely
// by PID: an explicit PID argument, then RUNNER_PID, then a pidfile the runner itself writes at
// startup (apps/runner/src/main.ts's `writePidFileBestEffort`). RUNNER_PIDFILE overrides the
// pidfile's path; both it and the dump file's own path (RUNNER_DIAGNOSTICS_FILE) default to the
// same RUNNER_DIAGNOSTICS_DIR-based location the runner itself defaults to
// (packages/shared/src/config/index.ts), so the common case — both sides left at their defaults —
// needs no configuration at all.
//
// Targets a runner process this script's own OS can signal directly — a bare process, or a
// container run with a shared PID namespace (`docker run --pid=host`). A container run under
// Compose's default, separate PID namespace is a known limitation, not solved here: the
// equivalent there is `docker exec <container> kill -USR2 1` plus reading the file back with
// `docker exec <container> cat <path>` or a mounted volume — recorded in QUESTIONS.md, consistent
// with this task's own guidance to avoid deep Docker involvement for a diagnostics convenience.
//
// 012 T048 review: liveness alone (`kill(pid, 0)` succeeding) proves a process exists at a pid,
// never that it is the runner a pidfile was written for. A pidfile left behind by an unclean exit
// (SIGKILL, OOM, an uncaught exception — none of which run `main.ts`'s graceful cleanup) and later
// reused by an unrelated process would otherwise make this script send SIGUSR2 to that unrelated
// process — whose default disposition, with no handler installed, is termination. The pidfile now
// also carries a random per-process `nonce` (`apps/runner/src/main.ts`'s `start()`), echoed into
// every dump's own `processNonce` field; this script cross-checks the two after signalling and
// refuses to trust a mismatched or missing dump, rather than trusting liveness alone.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from './lib/harness.mjs';

const DEFAULT_DIAGNOSTICS_DIR = process.env.RUNNER_DIAGNOSTICS_DIR ?? tmpdir();
const WAIT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

const COMPOSE_HINT =
  'If the runner is deployed via Docker Compose (a separate PID namespace from this script), this ' +
  "PID resolution can't reach it — use `docker exec <container> kill -USR2 1` and read the dump " +
  'back with `docker exec <container> cat <path>` or a mounted volume instead.';

/**
 * Which source identifies the runner process — the one decision this script makes that is worth
 * testing directly, since getting it wrong means signalling (or reporting "not found" against)
 * the wrong process entirely. A pidfile's own nonce (if resolved that way) becomes the expected
 * identity to cross-check the dump against; an explicit pid/`RUNNER_PID` has none to check.
 * @param {{ argv: string[], env: NodeJS.ProcessEnv }} source
 * @returns {{ kind: 'pid', pid: number } | { kind: 'pidfile', path: string }}
 */
export function resolvePidSource({ argv, env }) {
  const argPid = argv[2];
  if (argPid !== undefined) {
    const pid = Number.parseInt(argPid, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`invalid PID argument: ${argPid}`);
    }
    return { kind: 'pid', pid };
  }
  if (env.RUNNER_PID !== undefined) {
    const pid = Number.parseInt(env.RUNNER_PID, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`invalid RUNNER_PID: ${env.RUNNER_PID}`);
    }
    return { kind: 'pid', pid };
  }
  return { kind: 'pidfile', path: env.RUNNER_PIDFILE ?? null };
}

/**
 * Parses the runner's own pidfile format — JSON `{pid, nonce}`, not a bare integer (012 T048
 * review). `nonce` is optional in the parsed result only to tolerate an older-format or
 * hand-written file gracefully; the identity check downstream (`checkDumpIdentity`) treats a
 * missing expected nonce as "nothing to compare", not as a pass by default.
 * @param {string} text
 */
export function parsePidFileContent(text) {
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error(`pidfile does not contain valid JSON: ${JSON.stringify(text)}`);
  }
  const pid = parsed?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`pidfile does not contain a valid PID: ${JSON.stringify(text)}`);
  }
  if (parsed.nonce !== undefined && typeof parsed.nonce !== 'string') {
    throw new Error(`pidfile's nonce must be a string when present: ${JSON.stringify(text)}`);
  }
  return { pid, nonce: parsed.nonce };
}

/**
 * Whether a process at `pid` currently exists, and if not, why — signal `0` sends nothing, it only
 * probes. `ESRCH` (no such process) and `EPERM` (a process exists but this user may not signal it
 * — a different owner, or pid 1 of a container from the host) are distinct failure modes that
 * collapsing into one "not alive" would misreport (012 T048 review). `killFn` is injectable so a
 * test can force each branch without needing a real permission-denied process to probe.
 * @param {number} pid
 * @param {(pid: number) => void} [killFn]
 * @returns {{ status: 'alive' | 'not-found' | 'permission-denied' }}
 */
export function checkProcessLiveness(pid, killFn = (p) => process.kill(p, 0)) {
  try {
    killFn(pid);
    return { status: 'alive' };
  } catch (error) {
    if (error && error.code === 'ESRCH') return { status: 'not-found' };
    if (error && error.code === 'EPERM') return { status: 'permission-denied' };
    throw error;
  }
}

/**
 * The core fix (012 T048 review): confirms the dump this script just read actually came from the
 * process it just signalled, not from an unrelated process a stale, reused pid now happens to
 * name. `expectedNonce` is `undefined` when the pid came from an explicit argument/`RUNNER_PID`
 * (nothing was read to compare against) or from an older-format pidfile with no nonce — in either
 * case there is nothing to verify, so this reports `ok` rather than failing a check it cannot
 * actually perform.
 * @param {string | undefined} expectedNonce
 * @param {{ processNonce?: unknown } | null | undefined} bundle
 */
export function checkDumpIdentity(expectedNonce, bundle) {
  if (expectedNonce === undefined) return { ok: true };
  const actual = bundle && typeof bundle === 'object' ? bundle.processNonce : undefined;
  if (actual === expectedNonce) return { ok: true };
  return {
    ok: false,
    message:
      `diagnostics dump does not match the signalled process — expected process nonce ` +
      `${expectedNonce}, found ${actual ?? '(none)'}. This usually means the pidfile is stale and ` +
      `its pid has been reused by an unrelated process since the runner that wrote it exited.`,
  };
}

/* v8 ignore start -- real process signalling, fs polling and stdout; decision logic above is unit tested directly */
function resolvePid(source, defaultPidfilePath) {
  if (source.kind === 'pid') return { pid: source.pid, expectedNonce: undefined };
  const path = source.path ?? defaultPidfilePath;
  if (!existsSync(path)) {
    throw new Error(
      `no runner pidfile at ${path} — is a runner running? Pass a PID directly, or set ` +
        `RUNNER_PID/RUNNER_PIDFILE if it is not at the default location. ${COMPOSE_HINT}`,
    );
  }
  const { pid, nonce } = parsePidFileContent(readFileSync(path, 'utf8'));
  return { pid, expectedNonce: nonce };
}

function describeLivenessFailure(pid, liveness) {
  if (liveness.status === 'not-found') {
    return `no running process at pid ${pid} — is the runner still running? ${COMPOSE_HINT}`;
  }
  return (
    `a process exists at pid ${pid} but cannot be signalled by this user (permission denied) — ` +
    `run this script as the user that owns it. ${COMPOSE_HINT}`
  );
}

function mtimeOrNull(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

async function waitForDump(dumpPath, before) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const after = mtimeOrNull(dumpPath);
    if (after !== null && after !== before) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `timed out after ${WAIT_TIMEOUT_MS}ms waiting for ${dumpPath} to be written — the signalled ` +
      `process may not be a healer runner, or may be too old to handle SIGUSR2 (012 T048)`,
  );
}

if (isMainModule(import.meta.url)) {
  try {
    // Dynamic, not static: `PIDFILE_NAME`/`DIAGNOSTICS_DUMP_NAME` are the one authority
    // `apps/runner/src/diagnostics-paths.ts` also defines — reached here via its *compiled*
    // output, which only exists once the runner has been built. True by construction the moment
    // there is a runner process for this script to signal in the first place, but a static
    // top-level import would force every unit test of this file's pure functions above to also
    // depend on a prior `pnpm run build` — exactly what vitest's own workspace-package aliasing
    // (vitest.config.ts) exists to avoid for every other package in this monorepo. A dynamic
    // import, reached only on this real-execution path, keeps that property here too (012 T048
    // review: this script's own copy of these two names had silently drifted out of sync with
    // `main.ts`'s before this fix — a closed list has exactly one authority, AGENTS.md).
    const { PIDFILE_NAME, DIAGNOSTICS_DUMP_NAME } = await import(
      new URL('../apps/runner/dist/diagnostics-paths.js', import.meta.url)
    );
    const defaultPidfilePath = join(DEFAULT_DIAGNOSTICS_DIR, PIDFILE_NAME);
    const defaultDumpPath = join(DEFAULT_DIAGNOSTICS_DIR, DIAGNOSTICS_DUMP_NAME);

    const source = resolvePidSource({ argv: process.argv, env: process.env });
    const { pid, expectedNonce } = resolvePid(source, defaultPidfilePath);

    const liveness = checkProcessLiveness(pid);
    if (liveness.status !== 'alive') {
      throw new Error(describeLivenessFailure(pid, liveness));
    }

    const dumpPath = process.env.RUNNER_DIAGNOSTICS_FILE ?? defaultDumpPath;
    const before = mtimeOrNull(dumpPath);
    process.kill(pid, 'SIGUSR2');
    await waitForDump(dumpPath, before);

    const bundle = JSON.parse(readFileSync(dumpPath, 'utf8'));
    const identity = checkDumpIdentity(expectedNonce, bundle);
    if (!identity.ok) throw new Error(identity.message);

    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `runner-diagnostics failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
