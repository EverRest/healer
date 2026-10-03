#!/usr/bin/env node
// `gate-red-first` (012 T086, FR-056, R-14): an agent-authored change set has a test that fails
// against the base revision's production code. The change set's added or modified test files are
// laid over a temporary checkout of the base and only those run; any failure counts (a missing
// export is TDD's ordinary first red). A task marked `[NB]` is exempt — read from `tasks.md` on
// the BASE revision, so a change set cannot exempt itself.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { changedFilesSinceBase, resolveBaseRevision } from '../lib/changed-files.mjs';
import { resolveFromEnv } from './agent-identity.mjs';
import { TEST_FILE } from './agent-scope.mjs';

/**
 * True only when every `tasks.md` line for `taskId` carries `[NB]` among its leading markers
 * (`- [ ] T001 [P] [NB] [US1] …`). Task ids repeat across specs; ambiguity resolves to "rule applies".
 * @param {string[]} tasksTexts
 */
export function taskIsNoBehaviour(tasksTexts, taskId) {
  const id = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^- \\[[ xX]\\] ${id}(?=\\s)((?:\\s+\\[[^\\]]+\\])*)`, 'gm');
  const markers = tasksTexts.flatMap((text) => [...text.matchAll(line)].map((m) => m[1]));
  return markers.length > 0 && markers.every((m) => m.includes('[NB]'));
}

function baseTasksTexts(cwd, base) {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base, '--', 'specs'], {
    cwd,
    encoding: 'utf8',
  }).split('\n');
  return files
    .filter((f) => /^specs\/[^/]+\/tasks\.md$/.test(f))
    .map((f) => execFileSync('git', ['show', `${base}:${f}`], { cwd, encoding: 'utf8' }));
}

/**
 * @param {{ cwd: string, isAgent: boolean, taskId?: string,
 *           run: (worktree: string, files: string[]) => { failed: boolean } }} input
 */
export function redFirst({ cwd, isAgent, taskId, run }) {
  if (!isAgent) return { skipped: 'human-authored' };
  const base = resolveBaseRevision(cwd);
  if (taskId && taskIsNoBehaviour(baseTasksTexts(cwd, base), taskId)) {
    return { skipped: `no-behaviour task ${taskId}` };
  }
  const changed = changedFilesSinceBase(cwd);
  if (changed.length === 0) return { skipped: 'empty change set' };
  const tests = changed.filter((f) => TEST_FILE.test(f) && existsSync(join(cwd, f)));
  if (tests.length === 0) throw new Error('no added or modified test in the change set');

  const parent = mkdtempSync(join(tmpdir(), 'red-first-'));
  const worktree = join(parent, 'base');
  execFileSync('git', ['worktree', 'add', '--detach', worktree, base], { cwd, stdio: 'pipe' });
  try {
    for (const file of tests) {
      mkdirSync(dirname(join(worktree, file)), { recursive: true });
      copyFileSync(join(cwd, file), join(worktree, file));
    }
    if (!run(worktree, tests, cwd).failed) {
      throw new Error(`no added or modified test fails on the base revision: ${tests.join(', ')}`);
    }
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd, stdio: 'pipe' });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
  return { ran: tests };
}

/* v8 ignore start -- real vitest run; the verdict logic above is unit tested */
// The temp checkout has no installed dependencies: link every node_modules the real tree has.
function linkNodeModules(from, to, depth = 0) {
  if (existsSync(join(from, 'node_modules'))) {
    mkdirSync(to, { recursive: true });
    symlinkSync(join(from, 'node_modules'), join(to, 'node_modules'));
  }
  if (depth >= 3) return;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['node_modules', '.git', 'dist'].includes(entry.name)) continue;
    if (existsSync(join(to, entry.name)))
      linkNodeModules(join(from, entry.name), join(to, entry.name), depth + 1);
  }
}

// Fails closed on a runner that produced no readable result — a crash must not read as "red".
function vitestRunner(worktree, files, realCwd) {
  linkNodeModules(realCwd, worktree);
  const outputFile = join(dirname(worktree), 'report.json');
  const out = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${outputFile}`, ...files],
    { cwd: worktree, encoding: 'utf8' },
  );
  let report;
  try {
    report = JSON.parse(readFileSync(outputFile, 'utf8'));
  } catch {
    throw new Error(`vitest produced no readable report: ${out.stderr.slice(0, 500)}`);
  }
  return { failed: report.numFailedTests > 0 || report.numFailedTestSuites > 0 };
}

if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-red-first', async () => {
    redFirst({
      cwd: process.cwd(),
      isAgent: await resolveFromEnv(),
      taskId: process.env.TASK_ID,
      run: vitestRunner,
    });
  });
  reportAndExit(result);
}
/* v8 ignore stop */
