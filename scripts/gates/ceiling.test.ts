import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ceilingFromMigration, ceilingFromTs, findCeilingDrift } from './ceiling.mjs';

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
