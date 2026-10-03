#!/usr/bin/env node
// `gate-agent-scope` (012 T085, FR-055, SC-021, R-15): an agent-authored change set touches no
// protected path and no assertion in a test that exists on the base revision. A human-authored
// one is not this gate's business (FR-054 decides which is which — agent-identity.mjs).
//
// The protected-path list is parsed from the fenced block in the make-targets contract, read from
// the BASE revision: the contract is itself protected, and a list read from the head would let a
// change set shrink it first and then pass. Every unknown here throws (R-10).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { changedFilesSinceBase, resolveBaseRevision } from '../lib/changed-files.mjs';
import { resolveFromEnv } from './agent-identity.mjs';

export const CONTRACT_PATH = 'specs/012-engineering-foundation/contracts/make-targets.md';
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ASSERTION = /\b(?:expect\w*|assert\w*)(?:\.\w+)*\s*\(/;
// A test switched off keeps its assertion lines intact, so count the switches themselves.
const DISABLED =
  /\b(?:it|test|describe)(?:\.\w+)*\.(?:skip|todo|only|skipIf|runIf)\b|\bx(?:it|describe)\s*\(/g;

/** The fenced list under "### Protected paths": paths first on a line, prose after 3+ spaces. */
export function parseProtectedPaths(markdown) {
  const section = markdown.split(/^### Protected paths$/m)[1];
  const block = section?.match(/```text\n([\s\S]*?)\n```/)?.[1];
  if (!block) throw new Error('no fenced "Protected paths" block in the contract');
  const paths = [];
  for (const line of block.split('\n')) {
    if (!line.trim() || /^\s/.test(line)) continue; // blank, or a continuation of the prose
    if (line.trim() === 'this file') paths.push(CONTRACT_PATH);
    else
      paths.push(
        ...line
          .split(/\s{3,}/)[0]
          .trim()
          .split(/\s+/),
      );
  }
  return paths;
}

function globToRegExp(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\0')
    .replace(/\*\*/g, '\x01')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '(?:.*/)?')
    .replace(/\x01/g, '.*');
  return new RegExp(`^${body}$`);
}

const showAtBase = (cwd, base, path) =>
  execFileSync('git', ['show', `${base}:${path}`], { cwd, encoding: 'utf8', stdio: 'pipe' });

function existsAtBase(cwd, base, path) {
  try {
    execFileSync('git', ['cat-file', '-e', `${base}:${path}`], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Assertion lines present on the base and absent (or fewer) now. A multiset, so duplicating one
// assertion cannot mask removing another; an edited assertion shows up as a removed one.
function removedAssertions(before, after) {
  const remaining = new Map();
  for (const line of after.split('\n').map((l) => l.trim())) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  const removed = [];
  for (const line of before.split('\n').map((l) => l.trim())) {
    if (!ASSERTION.test(line)) continue;
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else removed.push(line);
  }
  return removed;
}

/** @returns {string[]} one message per violation; empty for a human-authored change set */
export function agentScopeViolations({ cwd, isAgent }) {
  if (!isAgent) return [];
  const base = resolveBaseRevision(cwd);
  const protectedPatterns = parseProtectedPaths(showAtBase(cwd, base, CONTRACT_PATH)).map(
    globToRegExp,
  );
  const violations = [];
  for (const path of changedFilesSinceBase(cwd)) {
    if (protectedPatterns.some((pattern) => pattern.test(path))) {
      violations.push(`protected path ${path}`);
    }
    if (!TEST_FILE.test(path) || !existsAtBase(cwd, base, path)) continue;
    if (!existsSync(join(cwd, path))) {
      violations.push(`deleted test ${path}`);
      continue;
    }
    const removed = removedAssertions(
      showAtBase(cwd, base, path),
      readFileSync(join(cwd, path), 'utf8'),
    );
    for (const line of removed) violations.push(`removed assertion in ${path}: ${line}`);
    const disabled = (text) => text.match(DISABLED)?.length ?? 0;
    if (disabled(readFileSync(join(cwd, path), 'utf8')) > disabled(showAtBase(cwd, base, path))) {
      violations.push(`disabled test in ${path} (skip/todo added)`);
    }
  }
  return violations;
}

/* v8 ignore start -- CLI wiring; logic above is unit tested */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-agent-scope', async () => {
    const violations = agentScopeViolations({
      cwd: process.cwd(),
      isAgent: await resolveFromEnv(),
    });
    if (violations.length > 0) {
      throw new Error(
        `agent-authored change set (set HEALER_AUTHOR_IDENTITY=human locally if it is yours): ${violations.join('; ')}`,
      );
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
