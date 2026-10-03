#!/usr/bin/env node
// `make runner-resolve-ref <uuid>` (003 T022, FR-009, R-08, quickstart 8): resolves a `localRef`
// from a withheld `collection_gap` — or a reduced item — to its original, against the runner's
// plane-local withholding ledger **only**.
//
// This script reads a directory on the machine it runs on. It makes no network call and takes no
// control-plane address, because there is nothing at the control plane to call: the ledger lives
// on the customer's storage and the control plane holds a reference it is structurally unable to
// dereference. A human inside the customer's network is the only resolver there is.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMainModule } from './lib/harness.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The reference comes from an argument (`make runner-resolve-ref <uuid>` or `REF=<uuid>`), is a
 * UUID or is refused: it is never used as a path fragment unchecked.
 * @param {{ argv: string[], env: NodeJS.ProcessEnv }} source
 */
export function parseRef({ argv, env }) {
  const ref = argv[2] ?? env.REF;
  if (ref === undefined || ref === '') {
    throw new Error('usage: make runner-resolve-ref <localRef-uuid>  (or REF=<uuid>)');
  }
  if (!UUID.test(ref)) throw new Error(`not a localRef: ${JSON.stringify(ref)} is not a UUID`);
  return ref;
}

/** @param {{ kind: string, collectorKey: string, itemClass: string, reasonCode?: string, detector?: string, sourceLocator: string, observedAt: string, expiresAt: string, originalTruncated: boolean, original: string, localRef: string }} entry */
export function formatEntry(entry) {
  return [
    `localRef:      ${entry.localRef}`,
    `kind:          ${entry.kind}${entry.kind === 'withheld' ? ' (nothing crossed the boundary)' : ' (a bounded, redacted excerpt crossed; the original stayed here)'}`,
    `collector:     ${entry.collectorKey}`,
    `item class:    ${entry.itemClass}`,
    `reason:        ${entry.reasonCode ?? '-'}${entry.detector ? ` (detector: ${entry.detector})` : ''}`,
    `source:        ${entry.sourceLocator}`,
    `observed at:   ${entry.observedAt}`,
    `expires at:    ${entry.expiresAt}`,
    `original${entry.originalTruncated ? ' (truncated at capture)' : ''}:`,
    entry.original,
  ].join('\n');
}

/* v8 ignore start -- real filesystem and stdout; parseRef/formatEntry above are unit tested */
if (isMainModule(import.meta.url)) {
  try {
    // Dynamic, like runner-diagnostics: the ledger is reached through its compiled output so this
    // file's pure functions above do not depend on a prior build.
    const { FsWithholdingLedger, LEDGER_DIR_NAME } = await import(
      new URL('../apps/runner/dist/collection/withholding-ledger.js', import.meta.url)
    );
    const ref = parseRef({ argv: process.argv, env: process.env });
    const dir = process.env.RUNNER_LEDGER_DIR ?? join(tmpdir(), LEDGER_DIR_NAME);
    const entry = new FsWithholdingLedger(dir).resolve(ref);
    if (entry === undefined) {
      throw new Error(
        `no ledger entry for ${ref} in ${dir} — it may have expired under this runner's retention, ` +
          `or belong to another runner. Set RUNNER_LEDGER_DIR if the ledger is elsewhere.`,
      );
    }
    process.stdout.write(`${formatEntry(entry)}\n`);
  } catch (error) {
    process.stderr.write(
      `runner-resolve-ref failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
