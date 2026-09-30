import { join } from 'node:path';

/**
 * The two file names `make runner-diagnostics` (012 T048, FR-024) reads and writes under
 * `RUNNER_DIAGNOSTICS_DIR` — the one authority both the writer (`main.ts`) and the reader
 * (`scripts/runner-diagnostics.mjs`, importing this file's *compiled* output — see that script's
 * own doc comment for why it is a dynamic import) use, instead of three independently-typed
 * copies of the same two strings silently drifting apart (a closed list has exactly one authority,
 * AGENTS.md — a real violation here per review, not a style nit: this file previously had its own
 * copy of both strings, `scripts/runner-diagnostics.mjs` had a second, and the e2e test a third).
 *
 * Deliberately its own tiny file with no other dependency, not folded into `main.ts` itself: it
 * needs to be importable — as compiled JS with nothing else attached — from a plain Node script
 * outside this package's own dependency graph.
 */
export const PIDFILE_NAME = 'healer-runner.pid';
export const DIAGNOSTICS_DUMP_NAME = 'healer-runner-diagnostics.json';

export function pidFilePath(diagnosticsDir: string): string {
  return join(diagnosticsDir, PIDFILE_NAME);
}

export function diagnosticsFilePath(diagnosticsDir: string): string {
  return join(diagnosticsDir, DIAGNOSTICS_DUMP_NAME);
}
