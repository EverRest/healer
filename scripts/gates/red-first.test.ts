import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureRepo, git, write } from '../lib/fixture-repo';
import { redFirst, taskIsNoBehaviour } from './red-first.mjs';

// Stand-in for the vitest run: each fixture "test" is a node script that exits non-zero on failure.
const run = (cwd: string, files: string[]) => ({
  failed: files.some((file) => spawnSync('node', [file], { cwd }).status !== 0),
});

const LIB = 'export const one = 1;\n';
const PASSING = "import { one } from './lib.mjs';\nif (one !== 1) throw new Error('x');\n";
// Needs an export the base revision's lib does not have — red on the base, green on the head.
const FAILING = "import { two } from './lib.mjs';\nif (two !== 2) throw new Error('x');\n";
const TASKS = 'specs/001-x/tasks.md';
const tasks = (marker = '') => `- [ ] T001 [P]${marker} [US1] do it\n- [ ] T002 [US1] other\n`;

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});
const repo = (marker = '') =>
  (dir = fixtureRepo({ 'lib.mjs': LIB, 'old.test.mjs': PASSING, [TASKS]: tasks(marker) }));
const head = () => {
  write(dir, 'lib.mjs', `${LIB}export const two = 2;\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'impl']);
};
const gate = (over: Record<string, unknown> = {}) =>
  redFirst({ cwd: dir, isAgent: true, taskId: 'T001', run, ...over });

describe('gate-red-first (012 T086, FR-056, R-14, quickstart 39)', () => {
  it('fails a new test that already passes on the base revision', () => {
    repo();
    write(dir, 'new.test.mjs', PASSING);
    expect(() => gate()).toThrow(/no added or modified test fails/);
  });

  it('passes a new test that fails on the base revision', () => {
    repo();
    write(dir, 'new.test.mjs', FAILING);
    head();
    expect(gate()).toEqual({ ran: ['new.test.mjs'] });
  });

  it('passes when only one of several tests fails', () => {
    repo();
    write(dir, 'a.test.mjs', PASSING);
    write(dir, 'b.test.mjs', FAILING);
    head();
    expect(gate().ran).toEqual(['a.test.mjs', 'b.test.mjs']);
  });

  it('counts a modified existing test, and runs only changed tests', () => {
    dir = fixtureRepo({
      'lib.mjs': LIB,
      'old.test.mjs': PASSING,
      'bystander.test.mjs': 'throw new Error("must not run");\n',
      [TASKS]: tasks(),
    });
    write(dir, 'old.test.mjs', FAILING);
    expect(gate().ran).toEqual(['old.test.mjs']);
  });

  it('has nothing to gate when the change set is empty', () => {
    repo();
    expect(gate()).toEqual({ skipped: 'empty change set' });
  });

  it('fails when the change set adds or modifies no test at all', () => {
    repo();
    write(dir, 'lib.mjs', `${LIB}export const two = 2;\n`);
    expect(() => gate()).toThrow(/no added or modified test/);
  });

  it('ignores a deleted test file', () => {
    repo();
    rmSync(`${dir}/old.test.mjs`);
    expect(() => gate()).toThrow(/no added or modified test/);
  });

  it('is skipped for a human-authored change set', () => {
    repo();
    write(dir, 'new.test.mjs', PASSING);
    expect(gate({ isAgent: false })).toEqual({ skipped: 'human-authored' });
  });

  it("is skipped when the base revision's tasks.md marks the task [NB]", () => {
    repo(' [NB]');
    write(dir, 'new.test.mjs', PASSING);
    expect(gate()).toEqual({ skipped: 'no-behaviour task T001' });
  });

  it('is NOT skipped by an [NB] the same change set adds to tasks.md', () => {
    repo();
    write(dir, TASKS, tasks(' [NB]'));
    write(dir, 'new.test.mjs', PASSING);
    expect(() => gate()).toThrow(/no added or modified test fails/);
  });

  it('applies the rule when no task is named', () => {
    repo(' [NB]');
    write(dir, 'new.test.mjs', PASSING);
    expect(() => gate({ taskId: undefined })).toThrow(/no added or modified test fails/);
  });

  it('fails closed when the base revision is missing', () => {
    repo();
    git(dir, ['branch', '-m', 'master', 'trunk']);
    write(dir, 'new.test.mjs', FAILING);
    expect(() => gate()).toThrow(/no base ref/);
  });

  it('removes its temporary worktree, pass or fail', () => {
    repo();
    write(dir, 'new.test.mjs', PASSING);
    expect(() => gate()).toThrow();
    write(dir, 'new.test.mjs', FAILING);
    gate();
    expect(git(dir, ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });
});

describe('taskIsNoBehaviour', () => {
  it('reads [NB] only from the marker position, not from description prose', () => {
    const text = '- [ ] T005 [US1] skipped when the task line carries `[NB]` on the base\n';
    expect(taskIsNoBehaviour([text], 'T005')).toBe(false);
    expect(taskIsNoBehaviour(['- [x] T005 [P] [NB] [US1] docs only\n'], 'T005')).toBe(true);
  });

  it('treats the id literally and checks every line for it, not just the first', () => {
    expect(taskIsNoBehaviour(['- [ ] T001 [NB] a\n'], 'T0.*')).toBe(false);
    expect(taskIsNoBehaviour(['- [ ] T001 [NB] a\n- [ ] T001 [US1] again\n'], 'T001')).toBe(false);
  });

  it('is not an exemption when the id is unknown, or marked in one spec but not another', () => {
    expect(taskIsNoBehaviour(['- [ ] T001 [NB] a\n'], 'T009')).toBe(false);
    expect(taskIsNoBehaviour(['- [ ] T0010 [NB] a\n'], 'T001')).toBe(false);
    expect(taskIsNoBehaviour(['- [ ] T001 [NB] a\n', '- [ ] T001 [US1] b\n'], 'T001')).toBe(false);
  });
});

describe('a push to the default branch (no change set)', () => {
  it('has nothing to gate for an agent-presumed run on master itself', () => {
    dir = fixtureRepo({ 'lib.mjs': LIB, [TASKS]: tasks() });
    git(dir, ['checkout', '-q', 'master']);
    expect(redFirst({ cwd: dir, isAgent: true, run })).toEqual({ skipped: 'empty change set' });
  });
});
