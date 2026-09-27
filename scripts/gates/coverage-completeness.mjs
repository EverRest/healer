#!/usr/bin/env node
// `gate-coverage-completeness` (R-11 follow-up): a file under one of the risk-weighted, 95%-floor
// directories that no test imports at all is invisible to `vitest.config.ts`'s coverage
// thresholds — `coverage.all: false` (chosen so untouched scaffold packages don't sink the global
// 80% floor) reports only files a test actually imported, so an unimported file simply never
// appears in the report rather than scoring 0%. This gate re-adds the guarantee `all: true` would
// give, but only for the four paths where it matters: every real-logic file under them must
// appear in the coverage summary, or this fails. Exempt: a file with no statements at all (an
// `export {}` entry surface — the placeholder every package started as per FR-001) has no logic
// to have missed a test for.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { stripComments } from '../lib/strip-comments.mjs';
import { RISK_WEIGHTED_DIRS } from '../lib/risk-weighted-paths.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COVERAGE_SUMMARY_PATH = join(REPO_ROOT, 'coverage/coverage-summary.json');

// A runtime declaration always uses one of these keywords in this codebase's style (every
// function is `function foo(...)` or `const foo = (...) => ...`). A file with none of them —
// only `import`/`export * from`/`export { x } from` re-exports, `export type`/`export interface`
// declarations, or nothing at all — compiles to zero executable statements. v8 can never assign
// such a file coverage, imported or not, which is a second, structural reason a file can be
// legitimately absent from the coverage report beyond the `export {}` FR-001 stub: a pure barrel
// `index.ts` or a domain package's `types.ts` has the same "nothing to have missed a test for"
// property, just for a different reason (type-erasure/re-export, not "not built yet").
const RUNTIME_DECLARATION_PATTERN = /\b(function|class|enum|const|let|var)\b/;

/** Content-based, not a path exclude list: a file that later gains real code (a `const`, a
 * `function`) stops being exempt without anyone updating a list. */
export function isNoLogicStub(content) {
  const stripped = stripComments(content).trim();
  if (stripped === '') return true;
  return !RUNTIME_DECLARATION_PATTERN.test(stripped);
}

/** @param {{ path: string, content: string }[]} files @param {string[]} coverageKeys */
export function findFilesMissingFromCoverage(files, coverageKeys) {
  const covered = new Set(coverageKeys);
  return files.filter((f) => !isNoLogicStub(f.content) && !covered.has(f.path)).map((f) => f.path);
}

/* v8 ignore start -- CLI wiring (real fs walk); logic above is unit tested */
function* walkTsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // `infrastructure/` (Prisma-touching repository code) is excluded from unit coverage
    // altogether (vitest.config.ts) — its real behaviour needs a live Postgres to test
    // meaningfully, so it is never a key in coverage-summary.json regardless of how well the e2e
    // suite exercises it. Walking into it here would flag every repository file as "untested" on
    // every run, the same false positive this gate exists to avoid for type-only/barrel files.
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'infrastructure')
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      yield full;
    }
  }
}

if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-coverage-completeness', () => {
    if (!existsSync(COVERAGE_SUMMARY_PATH)) {
      throw new Error(
        `${relative(REPO_ROOT, COVERAGE_SUMMARY_PATH)} not found — run \`make test-unit\` first (R-10)`,
      );
    }
    const coverageKeys = Object.keys(JSON.parse(readFileSync(COVERAGE_SUMMARY_PATH, 'utf8')));
    const files = RISK_WEIGHTED_DIRS.flatMap((dir) =>
      [...walkTsFiles(join(REPO_ROOT, dir))].map((path) => ({
        path,
        content: readFileSync(path, 'utf8'),
      })),
    );
    const missing = findFilesMissingFromCoverage(files, coverageKeys);
    if (missing.length > 0) {
      const names = missing.map((p) => relative(REPO_ROOT, p));
      throw new Error(
        `no test exercises the following risk-weighted file(s) at all (R-11): ${names.join(', ')}`,
      );
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
