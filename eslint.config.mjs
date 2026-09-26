// Flat config. Phase 2 carries only the rules the foundational tasks require;
// the boundary patterns of 012 T035 land in phase 5 (US3).
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'prisma/generated/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // T004: structured logging only. `console` is how an unstructured, untenanted,
      // uncorrelated line reaches production, and it is the one that carries a secret.
      'no-console': 'error',
      // `_`-prefixed names are deliberate: destructuring-with-rest is how a field is
      // removed from an immutable record, and the removed binding is never read.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Gate scripts and tests run on a terminal, where stdout is the product.
    files: ['scripts/**/*.mjs', '**/*.test.ts', 'vitest.config.ts'],
    rules: { 'no-console': 'off' },
  },
);
