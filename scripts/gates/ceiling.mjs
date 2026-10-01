#!/usr/bin/env node
// `gate-ceiling` (002 T038, SC-004, C-18). Two independent mechanisms enforce the autonomy
// ceiling (R-05): `ACTION_CEILING` in code (`packages/domain/policy/src/domain/ceiling.ts`) and
// the `policy_autonomy_grant_ceiling` DB trigger (migration
// `20261003060000_autonomy_grant_ceiling`). This gate is static and needs no database — it
// checks the two never disagree for the three action classes both can attest today
// (`read_only`, `code_change`, `repository_write`). A drift here would mean one mechanism
// silently permits a level the other forbids.
//
// `reversible_remediation` is deliberately excluded: the DB trigger refuses every level for that
// class (no `hasTestedUndo` data source exists — 010's catalogue is not built), which is *more*
// conservative than `ceiling.ts`'s own L5-once-attested answer, not a second copy of the same
// fact — comparing them would fail this gate for a difference that is correct by design, not a
// drift (see the migration's own comment).
//
// This is the SC-004/C-18 *data* half of `gate-ceiling` (002 make-targets.md). The FR-008a
// *diff* half — no change raising a ceiling level lands without a resolvable threshold-derivation
// citation — is Phase 9's addition (T086/T087), out of scope for this batch; extend this same
// gate, don't duplicate it, when that lands (the `gate-undo` precedent for a gate that grows a
// second check once its dependency exists).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const CEILING_TS = fileURLToPath(
  new URL('../../packages/domain/policy/src/domain/ceiling.ts', import.meta.url),
);
const MIGRATION_SQL = fileURLToPath(
  new URL(
    '../../prisma/migrations/20261003060000_autonomy_grant_ceiling/migration.sql',
    import.meta.url,
  ),
);

const TS_CONST_NAME = {
  read_only: 'READ_ONLY_CEILING',
  code_change: 'CODE_CHANGE_CEILING',
  repository_write: 'REPOSITORY_WRITE_CEILING',
};

/** @param {string} source */
export function ceilingFromTs(source) {
  /** @type {Record<string, number>} */
  const result = {};
  for (const [actionClass, constName] of Object.entries(TS_CONST_NAME)) {
    const match = source.match(new RegExp(`${constName}\\s*:\\s*AutonomyLevel\\s*=\\s*(\\d+)`));
    if (!match) throw new Error(`ceiling.ts: could not find a numeric ${constName}`);
    result[actionClass] = Number(match[1]);
  }
  return result;
}

/** @param {string} source */
export function ceilingFromMigration(source) {
  /** @type {Record<string, number>} */
  const result = {};
  for (const actionClass of Object.keys(TS_CONST_NAME)) {
    const match = source.match(new RegExp(`WHEN '${actionClass}' THEN (\\d+)`));
    if (!match) throw new Error(`migration.sql: could not find WHEN '${actionClass}' THEN <level>`);
    result[actionClass] = Number(match[1]);
  }
  return result;
}

/**
 * @param {string} tsSource
 * @param {string} migrationSource
 * @returns {string[]} one message per action class where the two mechanisms disagree
 */
export function findCeilingDrift(tsSource, migrationSource) {
  const fromTs = ceilingFromTs(tsSource);
  const fromMigration = ceilingFromMigration(migrationSource);
  return Object.keys(TS_CONST_NAME)
    .filter((actionClass) => fromTs[actionClass] !== fromMigration[actionClass])
    .map(
      (actionClass) =>
        `${actionClass}: ceiling.ts says ${fromTs[actionClass]}, the DB trigger says ${fromMigration[actionClass]}`,
    );
}

/* v8 ignore start -- CLI wiring; the parsing/comparison above is unit tested */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-ceiling', () => {
    const drift = findCeilingDrift(
      readFileSync(CEILING_TS, 'utf8'),
      readFileSync(MIGRATION_SQL, 'utf8'),
    );
    if (drift.length > 0) throw new Error(drift.join('; '));
  });
  reportAndExit(result);
}
/* v8 ignore stop */
