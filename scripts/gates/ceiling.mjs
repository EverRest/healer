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
// The FR-008a *diff* half (T086/T087, SC-009, R-15) lives in the same gate: a change that raises
// any level in `ACTION_CEILING` — or gives a level to a class that has none — must cite a
// `threshold_derivation` artifact the gate can resolve from the working tree. The ceiling is a
// literal in code, so no data check sees an edit to it; this reads the *edit* (base revision vs.
// working tree), never the database (ADR 0009). Citation form, one line per raised class,
// anywhere in `ceiling.ts`:
//
//   // derivation[<action_class>]: <run-id>      → docs/derivations/<run-id>.json
//
// A citation already present at the base does not earn a further raise.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveBaseRevision } from '../lib/changed-files.mjs';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { stripComments } from '../lib/strip-comments.mjs';

const CEILING_TS = fileURLToPath(
  new URL('../../packages/domain/policy/src/domain/ceiling.ts', import.meta.url),
);
const MIGRATION_SQL = fileURLToPath(
  new URL(
    '../../prisma/migrations/20261003060000_autonomy_grant_ceiling/migration.sql',
    import.meta.url,
  ),
);

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CEILING_TS_REPO_PATH = 'packages/domain/policy/src/domain/ceiling.ts';

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

const NONE = -1;
const ARTIFACT_FIELDS = [
  'thresholdKey',
  'value',
  'runId',
  'datasetVersionId',
  'metric',
  'realDenominator',
  'runSyntheticScoredCount',
  'runCompletionState',
  'runReproducibility',
  'runSplitScope',
  'artifactDigest',
];

/** Key-sorted JSON, so the digest does not depend on how an exporter ordered its fields. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over the artifact without its own `artifactDigest` field (the digest 011's exporter
 *  must record on `threshold_derivation.artifact_digest`). */
export function artifactDigestOf(artifact) {
  const { artifactDigest: _own, ...rest } = artifact;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

/**
 * The level each action class can reach (`-1` = none) as `ceiling.ts` declares it — for
 * `reversible_remediation` the level once its undo is attested. Fails closed on anything it
 * cannot read, so an unparseable edit is a failure and not "no raise".
 * @param {string} source
 * @returns {Record<string, number>}
 */
export function ceilingTable(source) {
  const code = stripComments(source);
  /** @type {Record<string, number>} */
  const consts = {};
  for (const m of code.matchAll(/const (\w+)\s*:\s*AutonomyLevel\s*=\s*(\d+)/g)) {
    consts[m[1]] = Number(m[2]);
  }
  const fn = code.match(/function ACTION_CEILING[\s\S]*/)?.[0];
  if (!fn) throw new Error('ceiling.ts: could not find function ACTION_CEILING');
  /** @type {Record<string, number>} */
  const table = {};
  for (const group of fn.matchAll(/((?:case '\w+':\s*)+)([\s\S]*?)(?=case '|$)/g)) {
    const level = group[2].match(/level:\s*(\w+)/)?.[1];
    let value;
    if (level === undefined) {
      if (!/\bNO_LEVEL\b/.test(group[2])) {
        throw new Error(`ceiling.ts: cannot read the level for ${group[1].trim()}`);
      }
      value = NONE;
    } else {
      value = /^\d+$/.test(level) ? Number(level) : consts[level];
      if (value === undefined) throw new Error(`ceiling.ts: unknown level constant ${level}`);
    }
    for (const c of group[1].matchAll(/case '(\w+)'/g)) table[c[1]] = value;
  }
  if (Object.keys(table).length === 0) throw new Error('ceiling.ts: ACTION_CEILING has no cases');
  return table;
}

/** @param {string} source @returns {Record<string, string>} action class → cited run id */
function citations(source) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const m of source.matchAll(/^\s*\/\/\s*derivation\[(\w+)\]:\s*([\w.-]+)\s*$/gm)) {
    result[m[1]] = m[2];
  }
  return result;
}

/**
 * FR-008a: one message per raised class whose raise is not earned by a resolvable derivation.
 * @param {string} baseSource `ceiling.ts` at the base revision ('' when it did not exist)
 * @param {string} newSource `ceiling.ts` in the working tree
 * @param {(runId: string) => string | undefined} readArtifact the committed artifact's text
 * @returns {string[]}
 */
export function findUnearnedRaises(baseSource, newSource, readArtifact) {
  const before = baseSource === '' ? {} : ceilingTable(baseSource);
  const after = ceilingTable(newSource);
  const baseCited = citations(baseSource);
  const cited = citations(newSource);
  const problems = [];
  for (const [actionClass, level] of Object.entries(after)) {
    if (level <= (before[actionClass] ?? NONE)) continue;
    const runId = cited[actionClass];
    if (runId === undefined || runId === baseCited[actionClass]) {
      problems.push(
        `${actionClass}: ceiling raised to ${level} but the change cites no derivation`,
      );
      continue;
    }
    const text = readArtifact(runId);
    let artifact;
    try {
      artifact = text === undefined ? undefined : JSON.parse(text);
    } catch {
      artifact = undefined;
    }
    if (artifact === undefined || ARTIFACT_FIELDS.some((f) => artifact[f] === undefined)) {
      problems.push(
        `${actionClass}: derivation ${runId} cannot be resolved to a complete artifact`,
      );
    } else if (artifact.runId !== runId) {
      problems.push(`${actionClass}: cites ${runId} but the artifact is for ${artifact.runId}`);
    } else if (artifact.artifactDigest !== artifactDigestOf(artifact)) {
      problems.push(`${actionClass}: derivation ${runId} digest does not match its content`);
    }
  }
  return problems;
}

/** The artifact's text when `docs/derivations/<runId>.json` exists AND git knows it (committed or
 *  staged): an untracked file satisfied the gate locally and then vanished in CI. */
export function readTrackedArtifact(root, runId) {
  if (!/^[\w.-]+$/.test(runId) || runId.includes('..')) return undefined;
  const rel = `docs/derivations/${runId}.json`;
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, stdio: 'pipe' });
    return readFileSync(`${root}/${rel}`, 'utf8');
  } catch {
    return undefined;
  }
}

/* v8 ignore start -- CLI wiring; the parsing/comparison above is unit tested */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-ceiling', () => {
    const drift = findCeilingDrift(
      readFileSync(CEILING_TS, 'utf8'),
      readFileSync(MIGRATION_SQL, 'utf8'),
    );
    if (drift.length > 0) throw new Error(drift.join('; '));
    // The merge-base, like every other gate: the tip of origin/master moves under a stale branch
    // (a lowered ceiling reads as a raise) and equals HEAD on a push to the default branch.
    const base = resolveBaseRevision(REPO_ROOT);
    let baseSource = '';
    try {
      baseSource = execFileSync('git', ['show', `${base}:${CEILING_TS_REPO_PATH}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      // absent at the base: every level is a raise
    }
    const raises = findUnearnedRaises(baseSource, readFileSync(CEILING_TS, 'utf8'), (runId) =>
      readTrackedArtifact(REPO_ROOT, runId),
    );
    if (raises.length > 0) throw new Error(raises.join('; '));
  });
  reportAndExit(result);
}
/* v8 ignore stop */
