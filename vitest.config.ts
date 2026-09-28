import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { RISK_WEIGHTED_DIRS } from './scripts/lib/risk-weighted-paths.mjs';

// A cross-package import (`@healer/shared`) resolves through the package's `exports` field to its
// *built* `dist/index.js`, while a same-package relative import (`./index.js` from inside
// `packages/shared/src/tenancy/`) is transformed live from `src/index.ts` by Vite — two different
// scripts as far as v8 coverage is concerned, even though both remap to the same reported source
// path. Their coverage entries don't merge, they concatenate: a function genuinely called through
// one path shows up as an *extra*, zero-count entry contributed by the other, understating
// coverage for code that is, in fact, fully exercised (confirmed empirically: importing
// `@healer/shared`'s `NotFoundError` as a real runtime value — not just a type — from a new
// consumer outside its own package dropped `packages/shared/src/tenancy/index.ts` from 100% to
// 83% function coverage with no code in that file touched). Aliasing every workspace package name
// to its own `src/index.ts` makes every import path — same-package or cross-package — resolve to
// the identical live-transformed module, permanently removing the split for every current and
// future package, not just this one.
function workspacePackageAliases(): { find: string; replacement: string }[] {
  const packagesRoot = fileURLToPath(new URL('./packages/', import.meta.url));
  const aliases: { find: string; replacement: string }[] = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      const pkgJsonPath = join(full, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name: string };
        aliases.push({ find: pkg.name, replacement: join(full, 'src/index.ts') });
      } else {
        scan(full); // a container directory (e.g. packages/domain/), not a package itself
      }
    }
  };
  scan(packagesRoot);
  return aliases;
}

// The e2e files whose result depends on the host being quiet — one authority for the list.
// Measured (001 review, 2026-09-28): with the whole e2e project running at once (a Postgres
// container per file, `cpus - 1` forks) the 12 000-signal replay ran at ~74 ms/signal for its
// first thousand and hit its 120 s budget in 4 of 4 full runs, `sustains 100/s` took 40-70 s and
// `issue-merge` 200-290 s (its forced-race cases failed under it); the same files run alone took
// ~50 s, ~6 s and ~35 s. The replay is a chain of ~5 serial round trips per signal on ONE row
// lock, so it scales with scheduling latency, not throughput (2 to 25 in flight measured the same).
// Each file below therefore gets its own `sequence.groupOrder`, which vitest runs one group at a
// time, after the shared group. (Pool size is root-level in vitest, so a project cannot be
// throttled directly — only ordered.)
const HEAVY_E2E = [
  'ingest-signal.e2e.test.ts',
  'apps/api/load.e2e.test.ts',
  'issue-repository.e2e.test.ts',
  'issue-merge.e2e.test.ts',
];

function e2eProject(name: string, include: string[], exclude: string[], groupOrder: number) {
  return {
    resolve: {
      alias: workspacePackageAliases(),
    },
    test: {
      name,
      include,
      exclude,
      environment: 'node' as const,
      testTimeout: 120_000,
      hookTimeout: 180_000,
      sequence: { groupOrder },
    },
  };
}

// Confirmed reachable, not just theoretical (001 review, 2026-09-28): two concurrent
// sessions each running the full e2e suite from their own worktree also ran each
// other's copy of it, quadrupling load on the suite's two heaviest tests (a 12 000-
// signal replay, a sustained-load test) and producing spurious timeouts neither
// session's own diff caused.
const E2E_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/.claude/worktrees/**'];

// Two kinds of project, because they cost different things: unit tests run on every save,
// e2e tests start disposable Postgres and Redis (R-12) and are not worth waiting for
// until the unit suite is green.
export default defineConfig({
  test: {
    projects: [
      {
        // `test.projects` gives each entry its own independent Vite config — a root-level
        // `resolve.alias` here does not reach into a project at all (confirmed empirically: it
        // silently had no effect until moved here), so the alias has to be declared per project.
        resolve: {
          alias: workspacePackageAliases(),
        },
        test: {
          name: 'unit',
          include: [
            'packages/**/*.test.ts',
            'apps/**/*.test.ts',
            'scripts/**/*.test.ts',
            'prisma/*.test.ts',
          ],
          // pnpm symlinks workspace dependencies under each package, so a bare
          // `packages/**` glob reaches into every dependency's own test suite.
          // `.claude/worktrees/**` is excluded for the same reason `node_modules` is: each
          // worktree is a full second checkout of this repo (Claude Code's own git-worktree
          // isolation), so an unscoped glob run from one worktree also picks up every test file
          // sitting inside every sibling worktree.
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/*.e2e.test.ts',
            '**/.claude/worktrees/**',
          ],
          environment: 'node',
        },
      },
      e2eProject(
        'e2e',
        ['**/*.e2e.test.ts'],
        [...E2E_EXCLUDE, ...HEAVY_E2E.map((f) => `**/${f}`)],
        0,
      ),
      ...HEAVY_E2E.map((f, i) => e2eProject(`e2e-heavy-${i + 1}`, [f], E2E_EXCLUDE, i + 1)),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Report only files a test actually imported. `all: true` (the v8 provider's default)
      // would sweep in every package's untouched placeholder `index.ts` — most of the
      // monorepo has no logic yet, only the entry surface T001 scaffolded — and the generated
      // Prisma client, sinking the global floor to a number that says nothing about the code
      // under test. A package earns a coverage number the day its spec lands with real tests.
      all: false,
      // `infrastructure/**` (Prisma-touching repository code, backend-nestjs.md) is excluded from
      // the *unit* coverage floor, not from testing: its real behaviour — tenant scoping, the
      // append-only guarantee, error translation — is only meaningful against a real Postgres
      // (append-only.e2e.test.ts already established this: the database's own rules are proven by
      // e2e, not by unit tests with a mocked client). The `unit` and `e2e` vitest projects run as
      // two separate `vitest run` invocations for a reason (fast loop vs. Docker-backed), so their
      // coverage does not naturally merge into one report; rather than force that merge, the gate
      // for this code is `make test-e2e` passing, not a line-coverage percentage computed only
      // from the half of the suite that never touches it.
      exclude: ['prisma/generated/**', '**/infrastructure/**'],
      // R-11: risk-weighted floors. Uniform high coverage buys tests of getters. `all: false`
      // means a file nobody's test ever imports is invisible here rather than merely low-scoring
      // — gate-coverage-completeness (scripts/gates/coverage-completeness.mjs) is what catches a
      // new file under one of these paths that no test touches at all.
      thresholds: {
        lines: 80,
        functions: 80,
        ...Object.fromEntries(
          RISK_WEIGHTED_DIRS.map((dir) => [`${dir}/**`, { lines: 95, functions: 95 }]),
        ),
      },
    },
  },
});
