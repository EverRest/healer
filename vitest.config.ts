import { defineConfig } from 'vitest/config';

// Two projects, because they cost different things: unit tests run on every save,
// e2e tests start disposable Postgres and Redis (R-12) and are not worth waiting for
// until the unit suite is green.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
          // pnpm symlinks workspace dependencies under each package, so a bare
          // `packages/**` glob reaches into every dependency's own test suite.
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['**/*.e2e.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // R-11: risk-weighted floors. Uniform high coverage buys tests of getters.
      thresholds: {
        lines: 80,
        functions: 80,
        'packages/domain/policy/**': { lines: 95, functions: 95 },
        'packages/domain/evidence/**': { lines: 95, functions: 95 },
        'packages/shared/src/tenancy/**': { lines: 95, functions: 95 },
        'packages/agents/src/output/**': { lines: 95, functions: 95 },
      },
    },
  },
});
