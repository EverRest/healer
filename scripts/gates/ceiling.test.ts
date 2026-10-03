import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  artifactDigestOf,
  ceilingFromMigration,
  ceilingFromTs,
  ceilingTable,
  findCeilingDrift,
  findUnearnedRaises,
  readTrackedArtifact,
} from './ceiling.mjs';
import { fixtureRepo, git, write } from '../lib/fixture-repo';

const CEILING_TS = readFileSync(
  fileURLToPath(new URL('../../packages/domain/policy/src/domain/ceiling.ts', import.meta.url)),
  'utf8',
);
const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20261003060000_autonomy_grant_ceiling/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

describe('gate-ceiling (002 T038, SC-004)', () => {
  it('parses the three ceilings ceiling.ts actually declares', () => {
    expect(ceilingFromTs(CEILING_TS)).toEqual({
      read_only: 1,
      code_change: 2,
      repository_write: 2,
    });
  });

  it('parses the three ceilings the migration trigger actually declares', () => {
    expect(ceilingFromMigration(MIGRATION_SQL)).toEqual({
      read_only: 1,
      code_change: 2,
      repository_write: 2,
    });
  });

  it('the committed migration and ceiling.ts agree today — no drift', () => {
    expect(findCeilingDrift(CEILING_TS, MIGRATION_SQL)).toEqual([]);
  });

  it('reports a drift when the two sources disagree', () => {
    const driftedMigration = MIGRATION_SQL.replace(
      "WHEN 'code_change' THEN 2",
      "WHEN 'code_change' THEN 3",
    );
    expect(findCeilingDrift(CEILING_TS, driftedMigration)).toEqual([
      'code_change: ceiling.ts says 2, the DB trigger says 3',
    ]);
  });

  it('throws when a source is missing a class entirely, rather than silently passing', () => {
    expect(() => ceilingFromTs('export const READ_ONLY_CEILING: AutonomyLevel = 1;')).toThrow(
      /CODE_CHANGE_CEILING/,
    );
    expect(() => ceilingFromMigration("WHEN 'read_only' THEN 1")).toThrow(/code_change/);
  });
});

// T086 / FR-008a / SC-009 / quickstart 40: the ceiling is a literal in code, so the check reads the
// *diff* (base source vs. new source) — no data check sees an edit to a literal.
describe('gate-ceiling diff half (002 T086, FR-008a)', () => {
  const raiseCodeChange = (citation = '') =>
    CEILING_TS.replace(
      'const CODE_CHANGE_CEILING: AutonomyLevel = 2;',
      `${citation}const CODE_CHANGE_CEILING: AutonomyLevel = 3;`,
    );

  const artifact = (overrides: Record<string, unknown> = {}) => {
    const body = {
      thresholdKey: 'fix_acceptance',
      value: 0.9,
      runId: 'run-1',
      datasetVersionId: 'ds-1',
      metric: 'precision',
      realDenominator: 24,
      runSyntheticScoredCount: 0,
      runCompletionState: 'complete',
      runReproducibility: 'reproducible',
      runSplitScope: 'benchmark',
      ...overrides,
    };
    return JSON.stringify({ ...body, artifactDigest: artifactDigestOf(body) });
  };

  it('parses the whole table, including classes that have no level', () => {
    expect(ceilingTable(CEILING_TS)).toEqual({
      read_only: 1,
      code_change: 2,
      repository_write: 2,
      reversible_remediation: 5,
      merge: -1,
      forward_deploy: -1,
      irreversible: -1,
    });
  });

  it('passes when nothing is raised, and when a level is lowered', () => {
    expect(findUnearnedRaises(CEILING_TS, CEILING_TS, () => undefined)).toEqual([]);
    const lowered = CEILING_TS.replace(
      'CODE_CHANGE_CEILING: AutonomyLevel = 2',
      'CODE_CHANGE_CEILING: AutonomyLevel = 1',
    );
    expect(findUnearnedRaises(CEILING_TS, lowered, () => undefined)).toEqual([]);
  });

  it('branch 1: a raise citing nothing fails', () => {
    expect(findUnearnedRaises(CEILING_TS, raiseCodeChange(), () => undefined)).toEqual([
      expect.stringMatching(/code_change.*cites no derivation/),
    ]);
  });

  it('branch 2: a raise citing an unresolvable derivation fails', () => {
    const source = raiseCodeChange('// derivation[code_change]: run-missing\n');
    expect(findUnearnedRaises(CEILING_TS, source, () => undefined)).toEqual([
      expect.stringMatching(/code_change.*run-missing.*cannot be resolved/),
    ]);
  });

  it('branch 3: a raise citing an artifact whose digest disagrees fails', () => {
    const source = raiseCodeChange('// derivation[code_change]: run-1\n');
    const tampered = JSON.stringify({ ...JSON.parse(artifact()), value: 0.99 });
    expect(findUnearnedRaises(CEILING_TS, source, () => tampered)).toEqual([
      expect.stringMatching(/code_change.*run-1.*digest/),
    ]);
  });

  it('branch 4: a raise citing a resolvable derivation passes', () => {
    const source = raiseCodeChange('// derivation[code_change]: run-1\n');
    expect(findUnearnedRaises(CEILING_TS, source, () => artifact())).toEqual([]);
  });

  it('an artifact for a different run than the one cited fails', () => {
    const source = raiseCodeChange('// derivation[code_change]: run-1\n');
    expect(findUnearnedRaises(CEILING_TS, source, () => artifact({ runId: 'run-2' }))).toEqual([
      expect.stringMatching(/run-1.*run-2/),
    ]);
  });

  it('a citation already present in the base does not earn a further raise', () => {
    const base = raiseCodeChange('// derivation[code_change]: run-1\n');
    const raisedAgain = base.replace(
      'CODE_CHANGE_CEILING: AutonomyLevel = 3',
      'CODE_CHANGE_CEILING: AutonomyLevel = 4',
    );
    expect(findUnearnedRaises(base, raisedAgain, () => artifact())).toEqual([
      expect.stringMatching(/code_change.*cites no derivation/),
    ]);
  });

  it('giving a class that has no level one is a raise (merge is the case that matters)', () => {
    const merge = CEILING_TS.replace(
      "    case 'merge':\n",
      "    case 'merge':\n      return { kind: 'level', level: 3 };\n",
    );
    expect(ceilingTable(merge).merge).toBe(3);
    expect(findUnearnedRaises(CEILING_TS, merge, () => undefined)).toEqual([
      expect.stringMatching(/merge.*cites no derivation/),
    ]);
  });

  it('fails closed on a ceiling.ts it cannot parse', () => {
    expect(() => ceilingTable('export const x = 1;')).toThrow(/ACTION_CEILING/);
  });

  // T087: the evaluation path gains no input — the strength of the ceiling is "a literal in code".
  it('ACTION_CEILING takes exactly (actionClass, hasTestedUndo) and reads no configuration', () => {
    expect(CEILING_TS).toMatch(
      /function ACTION_CEILING\(actionClass: ActionClass, hasTestedUndo: boolean\): Ceiling/,
    );
    expect(CEILING_TS).not.toMatch(/process\.env|@healer\/shared|import .*config/);
  });
});

describe('readTrackedArtifact (review of 0.52.0: "committed", not merely "on disk")', () => {
  it('resolves a tracked artifact, a staged one, and refuses an untracked one', () => {
    const dir = fixtureRepo({ 'docs/derivations/run-1.json': '{"runId":"run-1"}' });
    expect(readTrackedArtifact(dir, 'run-1')).toBe('{"runId":"run-1"}');
    write(dir, 'docs/derivations/run-2.json', '{"runId":"run-2"}');
    expect(readTrackedArtifact(dir, 'run-2')).toBeUndefined(); // on disk, in no commit or index
    git(dir, ['add', 'docs/derivations/run-2.json']);
    expect(readTrackedArtifact(dir, 'run-2')).toBe('{"runId":"run-2"}');
  });

  it('does not let a run id walk out of docs/derivations', () => {
    const dir = fixtureRepo({ 'secret.json': '{}' });
    expect(readTrackedArtifact(dir, '../secret')).toBeUndefined();
  });
});
