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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from './lib/harness.mjs';

const DEFAULT_DIAGNOSTICS_DIR = process.env.RUNNER_DIAGNOSTICS_DIR ?? tmpdir();
const DEFAULT_PIDFILE_PATH = join(DEFAULT_DIAGNOSTICS_DIR, 'healer-runner.pid');
const DEFAULT_DUMP_PATH = join(DEFAULT_DIAGNOSTICS_DIR, 'healer-runner-diagnostics.json');
const WAIT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

/**
 * Which source identifies the runner process — the one decision this script makes that is worth
 * testing directly, since getting it wrong means signalling (or reporting "not found" against)
 * the wrong process entirely.
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
  return { kind: 'pidfile', path: env.RUNNER_PIDFILE ?? DEFAULT_PIDFILE_PATH };
}

/** @param {string} text */
export function parsePidFileContent(text) {
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`pidfile does not contain a valid PID: ${JSON.stringify(text)}`);
  }
  return pid;
}

/** Whether a process at `pid` currently exists — signal `0` sends nothing, it only probes.
 *  @param {number} pid */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* v8 ignore start -- real process signalling, fs polling and stdout; decision logic above is unit tested directly */
function resolvePid(source) {
  if (source.kind === 'pid') return source.pid;
  if (!existsSync(source.path)) {
    throw new Error(
      `no runner pidfile at ${source.path} — is a runner running? Pass a PID directly, or set ` +
        `RUNNER_PID/RUNNER_PIDFILE if it is not at the default location.`,
    );
  }
  return parsePidFileContent(readFileSync(source.path, 'utf8'));
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
    const source = resolvePidSource({ argv: process.argv, env: process.env });
    const pid = resolvePid(source);
    if (!isProcessAlive(pid)) {
      throw new Error(`no running process at pid ${pid} — is the runner still running?`);
    }

    const dumpPath = process.env.RUNNER_DIAGNOSTICS_FILE ?? DEFAULT_DUMP_PATH;
    const before = mtimeOrNull(dumpPath);
    process.kill(pid, 'SIGUSR2');
    await waitForDump(dumpPath, before);

    const bundle = JSON.parse(readFileSync(dumpPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `runner-diagnostics failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
