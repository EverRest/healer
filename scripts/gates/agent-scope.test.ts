import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureRepo, git, write } from '../lib/fixture-repo';
import { agentScopeViolations, parseProtectedPaths, CONTRACT_PATH } from './agent-scope.mjs';

const contract = readFileSync(
  fileURLToPath(new URL(`../../${CONTRACT_PATH}`, import.meta.url)),
  'utf8',
);
const protectedPaths = parseProtectedPaths(contract);

// One concrete path that a pattern matches — derived from the parsed list, never typed out here.
const sample = (pattern: string) =>
  pattern === CONTRACT_PATH ? pattern : pattern.replace(/\*\*\//, 'x/').replace(/\*+/g, 'x');

const TEST_FILE = 'apps/api/thing.test.ts';
const BASE_TEST = "it('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n";

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});
const repo = (extra: Record<string, string> = {}) =>
  (dir = fixtureRepo({
    [CONTRACT_PATH]: contract,
    [TEST_FILE]: BASE_TEST,
    'a.ts': 'x\n',
    ...extra,
  }));

describe('protected-path list is parsed from the contract, not copied (012 T085, FR-055)', () => {
  it('parses every line of the fenced block, continuation prose excluded', () => {
    expect(protectedPaths).toEqual(
      expect.arrayContaining([
        '.specify/**',
        'specs/**/spec.md',
        'docs/adr/**',
        'docs/decisions.md',
        'AGENTS.md',
        'Makefile',
        'scripts/**',
        'eslint.config.mjs',
        'tsconfig*.json',
        '.gitlab-ci.yml',
        'test/*.ts',
        '.claude/skills/**',
        CONTRACT_PATH,
      ]),
    );
    expect(protectedPaths.some((p) => /\s|—/.test(p))).toBe(false);
  });

  it('fails closed when the fenced block is absent', () => {
    expect(() => parseProtectedPaths('# nothing here')).toThrow(/Protected paths/);
  });
});

describe('gate-agent-scope (012 T085, FR-055, SC-021, R-15, quickstart 36–38)', () => {
  it.each(protectedPaths)('fails an agent change to protected path %s', async (pattern) => {
    repo();
    const path = sample(pattern);
    write(dir, path, 'changed\n');
    const violations = agentScopeViolations({ cwd: dir, isAgent: true });
    expect(violations.join('\n')).toContain(path);
  });

  it('matches ** across directory depth, and * within one segment only', () => {
    repo();
    write(dir, 'scripts/gates/deep/x.mjs', 'x\n');
    write(dir, 'specs/012-x/nested/spec.md', 'x\n');
    write(dir, 'test/sub/helper.ts', 'x\n'); // test/*.ts is one level only
    const joined = agentScopeViolations({ cwd: dir, isAgent: true }).join('\n');
    expect(joined).toContain('scripts/gates/deep/x.mjs');
    expect(joined).toContain('specs/012-x/nested/spec.md');
    expect(joined).not.toContain('test/sub/helper.ts');
  });

  it('passes the same protected-path change when the author is human', () => {
    repo();
    write(dir, 'Makefile', 'changed\n');
    expect(agentScopeViolations({ cwd: dir, isAgent: false })).toEqual([]);
  });

  it('passes an agent change confined to ordinary files', () => {
    repo();
    write(dir, 'apps/api/new.ts', 'export {};\n');
    write(dir, 'a.ts', 'y\n');
    expect(agentScopeViolations({ cwd: dir, isAgent: true })).toEqual([]);
  });

  it('sees a committed change, not only a working-tree one', () => {
    repo();
    write(dir, 'Makefile', 'changed\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'edit']);
    expect(agentScopeViolations({ cwd: dir, isAgent: true }).join()).toContain('Makefile');
  });

  it('flags a protected file moved out of its path (rename shows both sides)', () => {
    repo({ Makefile: 'x\n' });
    git(dir, ['mv', 'Makefile', 'apps/Makefile']);
    expect(agentScopeViolations({ cwd: dir, isAgent: true }).join()).toContain('Makefile');
  });

  it("judges against the base revision's protected list — an edit shrinking the contract cannot excuse itself", () => {
    repo();
    write(dir, CONTRACT_PATH, contract.replace('Makefile  scripts/**', 'scripts/**'));
    write(dir, 'Makefile', 'changed\n');
    const joined = agentScopeViolations({ cwd: dir, isAgent: true }).join('\n');
    expect(joined).toContain(CONTRACT_PATH);
    expect(joined).toContain('Makefile');
  });

  it('fails closed when the contract is missing on the base revision', () => {
    dir = fixtureRepo({ 'a.ts': 'x\n' });
    expect(() => agentScopeViolations({ cwd: dir, isAgent: true })).toThrow();
  });

  it('fails closed when the base revision is missing', () => {
    repo();
    git(dir, ['branch', '-m', 'master', 'trunk']);
    expect(() => agentScopeViolations({ cwd: dir, isAgent: true })).toThrow(/no base ref/);
  });

  describe('pre-existing tests', () => {
    it('fails on a deleted test file present on the base revision', () => {
      repo();
      rmSync(`${dir}/${TEST_FILE}`);
      expect(agentScopeViolations({ cwd: dir, isAgent: true }).join()).toContain(
        `deleted test ${TEST_FILE}`,
      );
    });

    it('fails on a test file renamed away (the old path is deleted)', () => {
      repo();
      git(dir, ['mv', TEST_FILE, 'apps/api/renamed.test.ts']);
      expect(agentScopeViolations({ cwd: dir, isAgent: true }).join()).toContain(
        `deleted test ${TEST_FILE}`,
      );
    });

    it('fails on a removed expect( line — quickstart 37 — and passes for a human', () => {
      repo();
      write(dir, TEST_FILE, "it('a', () => {\n  expect(1).toBe(1);\n});\n");
      expect(agentScopeViolations({ cwd: dir, isAgent: true }).join()).toContain(
        'expect(2).toBe(2)',
      );
      expect(agentScopeViolations({ cwd: dir, isAgent: false })).toEqual([]);
    });

    it('fails on an assertion edited in place, and on an assert-family call', () => {
      repo({ 'a.test.ts': 'assertTenantIsolated(app, "GET", "/x");\n' });
      write(dir, TEST_FILE, BASE_TEST.replace('toBe(2)', 'toBe(3)'));
      write(dir, 'a.test.ts', 'assertTenantIsolated(app, "GET", "/y");\n');
      const joined = agentScopeViolations({ cwd: dir, isAgent: true }).join('\n');
      expect(joined).toContain('expect(2).toBe(2)');
      expect(joined).toContain('assertTenantIsolated(app, "GET", "/x")');
    });

    it('fails on a test switched off with skip/todo while its assertions stay', () => {
      repo();
      write(dir, TEST_FILE, BASE_TEST.replace("it('a'", "it.skip('a'"));
      expect(agentScopeViolations({ cwd: dir, isAgent: true }).join()).toContain('disabled test');
    });

    it.each([
      "it.only('a'",
      "it.skipIf(true)('a'",
      "it.runIf(false)('a'",
      "it.concurrent.skip('a'",
    ])('fails on a test narrowed or switched off with %s', (replacement) => {
      repo();
      write(dir, TEST_FILE, BASE_TEST.replace("it('a'", replacement));
      expect(agentScopeViolations({ cwd: dir, isAgent: true }).join()).toContain('disabled test');
    });

    it('flags a protected non-ASCII path (git would C-quote it)', () => {
      repo();
      write(dir, 'scripts/é.mjs', 'x\n');
      expect(agentScopeViolations({ cwd: dir, isAgent: true }).join()).toContain('scripts/é.mjs');
    });

    it('counts expect.soft( and expectTypeOf( as assertions', () => {
      repo({ 'b.test.ts': 'expect.soft(1).toBe(1);\nexpectTypeOf(x).toBeString();\n' });
      write(dir, 'b.test.ts', '\n');
      const joined = agentScopeViolations({ cwd: dir, isAgent: true }).join('\n');
      expect(joined).toContain('expect.soft(1)');
      expect(joined).toContain('expectTypeOf(x)');
    });

    it('passes added assertions and added test files', () => {
      repo();
      write(dir, TEST_FILE, `${BASE_TEST}expect(3).toBe(3);\n`);
      write(dir, 'apps/api/fresh.test.ts', 'expect(1).toBe(1);\n');
      expect(agentScopeViolations({ cwd: dir, isAgent: true })).toEqual([]);
    });

    it('passes removing a non-assertion line from an old test', () => {
      repo({ [TEST_FILE]: `const x = 1;\n${BASE_TEST}` });
      write(dir, TEST_FILE, BASE_TEST);
      expect(agentScopeViolations({ cwd: dir, isAgent: true })).toEqual([]);
    });
  });
});
