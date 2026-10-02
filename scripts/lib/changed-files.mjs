// Which files changed in this change set, relative to a base revision (012 T076/T078's shared
// need, and eventually T085/T086's). Fails closed (R-10): when no base is resolvable — a shallow
// clone, no default-branch ref, git itself missing — the caller gets an error, not an empty diff
// that would make "nothing changed" indistinguishable from "the schema changed and nothing else
// did".
import { execFileSync } from 'node:child_process';

const CANDIDATE_BASE_REFS = ['origin/master', 'origin/main', 'master', 'main'];

// Exported so every gate that needs "the base revision" (deps-check's ADR-diff check included)
// resolves it the same way — a second, independently-drifting copy of this list is how the two
// gates disagreed on what "no base ref" even means (one fell back to HEAD, silently defeating its
// own diff; this one is the version that actually fails closed).
export function resolveBaseRef(cwd) {
  for (const ref of CANDIDATE_BASE_REFS) {
    try {
      execFileSync('git', ['rev-parse', '--verify', ref], { cwd, stdio: 'pipe' });
      return ref;
    } catch {
      continue;
    }
  }
  return undefined;
}

// The commit the change set forks from (merge-base with the base ref). Fails closed like
// changedFilesSinceBase: no base is an error, never an empty answer.
export function resolveBaseRevision(cwd = process.cwd()) {
  const baseRef = resolveBaseRef(cwd);
  if (!baseRef) {
    throw new Error(`no base ref resolved (tried ${CANDIDATE_BASE_REFS.join(', ')}) (R-10)`);
  }
  return execFileSync('git', ['merge-base', baseRef, 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

function workingTreeChanges(cwd) {
  // Uncommitted changes against HEAD, staged or not — a local `make ci` run on a feature branch
  // with no commits yet (the common case while iterating) must see these, or the gate only ever
  // fires once something has already been committed, which is too late for R-09's "identical
  // locally and in CI".
  const tracked = execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
  });
  return [...tracked.split('\n'), ...untracked.split('\n')];
}

export function changedFilesSinceBase(cwd = process.cwd()) {
  const baseRef = resolveBaseRef(cwd);
  if (!baseRef) {
    throw new Error(
      `changedFilesSinceBase: no base ref resolved (tried ${CANDIDATE_BASE_REFS.join(', ')}) — ` +
        'refusing to silently treat this as "nothing changed" (R-10)',
    );
  }
  const committed = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', `${baseRef}...HEAD`],
    {
      cwd,
      encoding: 'utf8',
    },
  ).split('\n');
  const all = [...committed, ...workingTreeChanges(cwd)];
  return [...new Set(all.map((f) => f.trim()).filter(Boolean))];
}
