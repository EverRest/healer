import { describe, expect, it } from 'vitest';
import {
  allDependencyNames,
  findImpermissiveLicenses,
  findUnapprovedDependencies,
  findUnapprovedExtensions,
  findUndocumentedNewDependencies,
} from './deps-check.mjs';

describe('deps-check: dependency allowlist (012 T037, FR-006, quickstart 31)', () => {
  it('fails on a dependency not on the approved list', () => {
    const issues = findUnapprovedDependencies([
      { path: 'apps/api/package.json', dependencies: ['left-pad'] },
    ]);
    expect(issues).toEqual([
      'apps/api/package.json: left-pad is not on the approved list (FR-006)',
    ]);
  });

  it('never flags a workspace package', () => {
    expect(
      findUnapprovedDependencies([
        { path: 'apps/api/package.json', dependencies: ['@healer/shared'] },
      ]),
    ).toEqual([]);
  });

  it('passes an already-approved dependency', () => {
    expect(findUnapprovedDependencies([{ path: 'x', dependencies: ['zod'] }])).toEqual([]);
  });
});

describe('deps-check: new dependency needs an ADR in the same change set (012 T078, FR-006)', () => {
  it('fails when a new dependency has no changed ADR mentioning it', () => {
    const issues = findUndocumentedNewDependencies(['left-pad'], []);
    expect(issues).toEqual([
      'left-pad: new dependency with no ADR naming it in this change set (FR-006)',
    ]);
  });

  it('fails when an ADR changed but does not mention the new dependency', () => {
    const issues = findUndocumentedNewDependencies(
      ['left-pad'],
      ['# ADR 0012\n\nUnrelated decision.'],
    );
    expect(issues).toHaveLength(1);
  });

  it('passes when a changed ADR mentions the new dependency by name', () => {
    const issues = findUndocumentedNewDependencies(
      ['left-pad'],
      ['# ADR 0012\n\nWe adopt left-pad because...'],
    );
    expect(issues).toEqual([]);
  });

  it('is silent when nothing new was added', () => {
    expect(findUndocumentedNewDependencies([], [])).toEqual([]);
  });

  it('never requires an ADR for a new internal @healer/* dependency edge — FR-006 governs external risk', () => {
    expect(findUndocumentedNewDependencies(['@healer/domain-evidence'], [])).toEqual([]);
  });

  it('still requires an ADR for an external dependency added alongside an internal one', () => {
    const issues = findUndocumentedNewDependencies(['@healer/domain-evidence', 'left-pad'], []);
    expect(issues).toEqual([
      'left-pad: new dependency with no ADR naming it in this change set (FR-006)',
    ]);
  });
});

describe('deps-check: Postgres extension allowlist (ADR 0004)', () => {
  it('fails on an extension ADR 0004 does not approve', () => {
    const schema = 'datasource db {\n  extensions = [vector, pg_trgm, postgis]\n}\n';
    expect(findUnapprovedExtensions(schema)).toEqual(['postgis']);
  });

  it('passes the approved pair', () => {
    const schema = 'datasource db {\n  extensions = [vector, pg_trgm]\n}\n';
    expect(findUnapprovedExtensions(schema)).toEqual([]);
  });
});

describe('deps-check: allDependencyNames sees every dependency field, not just runtime (FR-006)', () => {
  it('collects names from dependencies, devDependencies, optionalDependencies and peerDependencies', () => {
    const names = allDependencyNames({
      dependencies: { zod: '1.0.0' },
      devDependencies: { husky: '9.0.0' },
      optionalDependencies: { fsevents: '2.0.0' },
      peerDependencies: { typescript: '5.0.0' },
    });
    expect(new Set(names)).toEqual(new Set(['zod', 'husky', 'fsevents', 'typescript']));
  });

  it('deduplicates a name declared under more than one field', () => {
    const names = allDependencyNames({
      dependencies: { zod: '1.0.0' },
      devDependencies: { zod: '1.0.0' },
    });
    expect(names).toEqual(['zod']);
  });

  it('is empty for a package.json with no dependency fields', () => {
    expect(allDependencyNames({})).toEqual([]);
  });
});

describe('deps-check: permissive licences', () => {
  it('fails on a copyleft licence in the tree', () => {
    expect(findImpermissiveLicenses({ MIT: [], 'GPL-3.0': [] })).toEqual(['GPL-3.0']);
  });

  it('passes an all-permissive tree', () => {
    expect(findImpermissiveLicenses({ MIT: [], 'Apache-2.0': [], ISC: [] })).toEqual([]);
  });
});
