import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedFilesSinceBase, resolveBaseRevision } from './changed-files.mjs';

/**
 * Isolated fixture repos rather than assertions against this repository's own transient git
 * state, which would break the moment these changes are committed — exactly the kind of
 * self-referential fragility a gate's own test must not have.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changed-files-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'a.txt'), 'initial\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  git(dir, ['branch', '-m', 'master']);
  return dir;
}

describe('changedFilesSinceBase (012 T076/T078 shared base-diff, R-09, R-10)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('sees uncommitted working-tree changes on the same branch as the base ref', () => {
    dir = initRepo();
    writeFileSync(join(dir, 'b.txt'), 'new file\n');
    expect(changedFilesSinceBase(dir)).toEqual(['b.txt']);
  });

  it('sees staged changes too, not only untracked files', () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.txt'), 'modified\n');
    git(dir, ['add', 'a.txt']);
    expect(changedFilesSinceBase(dir)).toEqual(['a.txt']);
  });

  it('sees commits on a feature branch that has diverged from master', () => {
    dir = initRepo();
    git(dir, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(dir, 'c.txt'), 'from a real commit\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'add c']);
    expect(changedFilesSinceBase(dir)).toEqual(['c.txt']);
  });

  it('returns an empty, deduplicated list when nothing has changed', () => {
    dir = initRepo();
    expect(changedFilesSinceBase(dir)).toEqual([]);
  });

  it('fails closed instead of silently reporting no changes when no base ref resolves at all (R-10)', () => {
    dir = initRepo();
    git(dir, ['branch', '-m', 'trunk']); // neither master nor main, and no origin remote
    expect(() => changedFilesSinceBase(dir)).toThrow(/no base ref resolved/);
  });

  it('reports both sides of a rename, so a move out of a watched path is not invisible (T085)', () => {
    dir = initRepo();
    git(dir, ['mv', 'a.txt', 'moved.txt']);
    expect(changedFilesSinceBase(dir).sort()).toEqual(['a.txt', 'moved.txt']);
  });

  it('resolves the base revision to the merge-base commit, and fails closed without one', () => {
    dir = initRepo();
    const base = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(dir, 'c.txt'), 'x\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'c']);
    expect(resolveBaseRevision(dir)).toBe(base);
    git(dir, ['branch', '-m', 'master', 'trunk']);
    expect(() => resolveBaseRevision(dir)).toThrow(/no base ref resolved/);
  });
});
