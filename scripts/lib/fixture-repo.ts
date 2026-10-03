import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// A throwaway git repo for gate tests: `base` files committed on `master`, then a `feature`
// branch checked out where the test applies the change set (committed or not).
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

export function fixtureRepo(base: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fixture-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  for (const [path, content] of Object.entries(base)) write(dir, path, content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  return dir;
}
