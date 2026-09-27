import { describe, expect, it } from 'vitest';
import {
  adrExists,
  findUnapprovedIrreversibleMigrations,
  validateIrreversibleApproval,
} from './db-check.mjs';

describe('adrExists (against the real docs/adr/ directory)', () => {
  it('finds an ADR that exists', () => {
    expect(adrExists('4')).toBe(true);
    expect(adrExists('0004')).toBe(true);
  });

  it('reports false for an ADR number that does not exist', () => {
    expect(adrExists('9999')).toBe(false);
  });
});

const deps = { adrExists: (n: string) => n === '0012' };

describe('db-check: irreversible migration approval (012 T075, FR-049, quickstart 35)', () => {
  it('is silent on a migration with no destructive statement, with or without a reverse', () => {
    const issues = findUnapprovedIrreversibleMigrations(
      [
        {
          name: '20260101_add_index',
          upSql: 'CREATE INDEX x ON t(y);',
          approvalContent: undefined,
        },
      ],
      deps,
    );
    expect(issues).toEqual([]);
  });

  it('rejects a destructive migration with no approval file, even when it ships a down.sql', () => {
    // A down.sql can restore the dropped column's shape, never the data it held — "has a
    // reverse" is not "lossless" (the gap a down.sql-only check would miss).
    const issues = findUnapprovedIrreversibleMigrations(
      [
        {
          name: '20260101_drop_column',
          upSql: 'ALTER TABLE t DROP COLUMN spend_limit;',
          approvalContent: undefined,
        },
      ],
      deps,
    );
    expect(issues).toEqual(['20260101_drop_column: missing IRREVERSIBLE.md']);
  });

  it('does not flag a trigger that fires BEFORE TRUNCATE — it prevents a truncate, not performs one', () => {
    const issues = findUnapprovedIrreversibleMigrations(
      [
        {
          name: 'm1',
          upSql:
            'CREATE TRIGGER t_no_truncate BEFORE TRUNCATE ON "s"."t" FOR EACH STATEMENT EXECUTE FUNCTION f();',
          approvalContent: undefined,
        },
      ],
      deps,
    );
    expect(issues).toEqual([]);
  });

  it('does not flag a comment merely mentioning TRUNCATE in prose', () => {
    const issues = findUnapprovedIrreversibleMigrations(
      [
        {
          name: 'm1',
          upSql:
            '-- TRUNCATE bypasses row-level triggers, so this table also gets one.\nCREATE INDEX x ON t(y);',
          approvalContent: undefined,
        },
      ],
      deps,
    );
    expect(issues).toEqual([]);
  });

  it('rejects TRUNCATE and DROP TABLE too', () => {
    const issues = findUnapprovedIrreversibleMigrations(
      [
        { name: 'm1', upSql: 'TRUNCATE t;', approvalContent: undefined },
        { name: 'm2', upSql: 'DROP TABLE t;', approvalContent: undefined },
      ],
      deps,
    );
    expect(issues).toEqual(['m1: missing IRREVERSIBLE.md', 'm2: missing IRREVERSIBLE.md']);
  });

  it('rejects an approval that names no ADR', () => {
    expect(validateIrreversibleApproval('Owner: alice', deps)).toMatch(/ADR/);
  });

  it('rejects an approval citing an ADR that does not exist', () => {
    expect(validateIrreversibleApproval('See ADR 9999. Owner: alice', deps)).toMatch(
      /does not exist/,
    );
  });

  it('rejects an approval with an empty owner line', () => {
    expect(validateIrreversibleApproval('See ADR 0012. Owner:', deps)).toMatch(/owner/i);
  });

  it('accepts a destructive migration approved with a real ADR and a named owner', () => {
    const issues = findUnapprovedIrreversibleMigrations(
      [
        {
          name: '20260101_drop_column',
          upSql: 'ALTER TABLE t DROP COLUMN spend_limit;',
          approvalContent: 'See ADR 0012. Owner: alice',
        },
      ],
      deps,
    );
    expect(issues).toEqual([]);
  });
});
