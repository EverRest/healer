// Shared by every gate under scripts/ and scripts/gates/ (012 T025, R-10).
//
// The result type has no "skip" or "unknown" state on purpose: a check that cannot
// determine the answer — the base commit is missing, the schema cannot be introspected —
// throws, and `runGate` turns any thrown error into a fail. A gate that passes when
// confused produces a false record of compliance, which is worse than no gate (R-10).

import { pathToFileURL } from 'node:url';

/**
 * Whether `entryUrl` (a script's own `import.meta.url`) is the file Node was invoked on.
 * `import.meta.url === \`file://${process.argv[1]}\`` looks equivalent but is not: a space,
 * a non-ASCII character or any other percent-encodable byte in the path makes `import.meta.url`
 * (always percent-encoded) diverge from the raw `argv[1]` string, and the guard then matches
 * nothing — so the gate silently runs zero checks and exits 0 instead of failing closed (R-10).
 * Re-deriving the URL from `argv[1]` the same way Node derives it compares like with like.
 */
export function isMainModule(entryUrl) {
  return process.argv[1] !== undefined && entryUrl === pathToFileURL(process.argv[1]).href;
}

/**
 * @param {string} name
 * @param {() => Promise<void> | void} check
 * @returns {Promise<{ gate: string, outcome: 'pass' | 'fail', reason?: string }>}
 */
export async function runGate(name, check) {
  try {
    await check();
    return { gate: name, outcome: 'pass' };
  } catch (error) {
    return {
      gate: name,
      outcome: 'fail',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Prints the machine-readable result and exits with the matching status code. */
export function reportAndExit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.outcome === 'pass' ? 0 : 1;
}
