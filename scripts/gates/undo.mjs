#!/usr/bin/env node
// `gate-undo` (012 T030, FR-014, satisfies 002 SC-005): every entry in the reversible action
// catalogue (010) must have a passing undo test.
//
// The catalogue is code, at `packages/domain/remediation/domain/catalogue/` (010 R-01) — a
// directory 010 has not created yet. Until it exists there is nothing to enumerate, which is a
// determinable fact, not an unknown (R-10): the gate passes and says so, rather than skipping
// silently. 010 R-02 also defines admission as an *attestation* the undo test run produced
// (naming the catalogue digest and build), not merely "a test file exists" — that attestation
// format is 010's to design; this gate enumerates the catalogue once one exists and is expected
// to grow real per-entry checking as part of 010's own tasks, the same way `db-check`'s
// previous-release check activates the day a release is tagged.
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const CATALOGUE_DIR = fileURLToPath(
  new URL('../../packages/domain/remediation/domain/catalogue/', import.meta.url),
);

export function catalogueEntries() {
  if (!existsSync(CATALOGUE_DIR)) return [];
  return readdirSync(CATALOGUE_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => entry.name);
}

/* v8 ignore start -- CLI wiring; catalogueEntries above is unit tested */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-undo', () => {
    const entries = catalogueEntries();
    if (entries.length === 0) {
      process.stderr.write(
        'gate-undo: no reversible action catalogue yet (010 not implemented) — nothing to check\n',
      );
      return;
    }
    // 010 lands the attestation format and the real per-entry check alongside the catalogue
    // itself (R-02) — enumerating without a defined attestation to verify would be a check
    // that always passes once any file exists, which is worse than the honest gap above.
    throw new Error(
      `catalogue has ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} but gate-undo has no attestation check yet — extend this gate as part of 010`,
    );
  });
  reportAndExit(result);
}
/* v8 ignore stop */
