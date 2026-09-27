// Flat config. Boundaries are enforced by pattern (R-01, 012 T035/T036), not by naming every
// package that could violate them — a new package under packages/domain/** or packages/agents/**
// is governed the moment it exists, with no edit to this file (quickstart 3).
import tseslint from 'typescript-eslint';

// ADR 0006: direct provider SDKs belong only behind packages/llm/*/infrastructure/**.
const PROVIDER_SDKS = [
  '@anthropic-ai/sdk',
  'openai',
  '@aws-sdk/client-bedrock-runtime',
  '@google-cloud/vertexai',
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'prisma/generated/**'] },
  // T077, FR-005: an exception to a boundary rule exists only as a recorded entry referencing an
  // ADR and naming an owner (docs/boundary-exceptions.md) — never an inline `eslint-disable`.
  // ESLint has no per-rule "cannot be disabled inline" switch, so this is repo-wide: every
  // `eslint-disable` comment anywhere becomes a no-op (confirmed: the suppressed rule still
  // reports). The only way to except a path from a rule is an `ignores` entry in *this* file,
  // which is reviewed code, not a comment slipped into an unrelated diff.
  { linterOptions: { noInlineConfig: true } },
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
    // T036: lint limits. Tests are exempt — a table of fixtures or a long list of assertions
    // is not the same complexity as a long function of branches.
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.e2e.test.ts'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 15],
      'max-depth': ['error', 4],
    },
  },
  {
    // T035 FR-002/FR-003. `@prisma/client` confined to infrastructure/** and prisma/** —
    // domain and application code depends on repository interfaces, never the client
    // (.claude/rules/backend-nestjs.md). `@healer/prisma-client` (ADR 0013) re-exports the same
    // generated client under a stable workspace name — the restriction follows it there too, or
    // it would be a two-character import-path change away from bypassing this rule entirely.
    // Provider SDKs behind their adapter only (ADR 0006).
    //
    // Both live in one `no-restricted-imports` call on purpose: ESLint flat config does not
    // merge a rule's options across matching config objects — the last one for a given file
    // wins outright — so a second block setting the same rule key would silently discard
    // this one for every file both blocks match.
    files: ['**/*.ts'],
    ignores: ['**/infrastructure/**', 'prisma/**', '**/*.test.ts', '**/*.e2e.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: PROVIDER_SDKS.map((name) => ({
            name,
            message: `${name} is confined to packages/llm/*/infrastructure/** (ADR 0006)`,
          })),
          patterns: [
            {
              group: ['@prisma/client', '**/prisma/generated/**', '@healer/prisma-client'],
              message:
                '@prisma/client (including @healer/prisma-client, ADR 0013) is confined to infrastructure/** and prisma/** (backend-nestjs.md)',
            },
          ],
        },
      ],
    },
  },
  {
    // T035 FR-043/FR-044. `process.env` is read once, in packages/shared/src/config, and exposed
    // to the rest of the code as typed, validated values — everywhere else reads config, not
    // the environment (.claude/rules/backend-nestjs.md).
    //
    // The selector matches the `process.env` node itself, not `process.env.FOO` specifically —
    // matching one level up is what also catches a destructured
    // `const { FOO } = process.env` and a bare `const env = process.env`, both of which read
    // straight past a selector anchored on the `.FOO` access (confirmed: both passed lint under
    // the narrower selector; a real, reachable bypass, not a hypothetical one).
    //
    // `**/processors/**` is excluded here and re-declared, selector and all, in the dedicated
    // processors block below: `no-restricted-syntax` has no TS-specific alternate name the way
    // `no-restricted-imports` does, and a selector cannot itself test the file path, so two
    // blocks with overlapping `files` would hit the same last-one-wins collision T035 already
    // found once (see that block's comment) — disjoint file sets is the only fix available here.
    files: ['**/*.ts'],
    ignores: [
      'packages/shared/src/config/**',
      '**/processors/**',
      '**/*.test.ts',
      '**/*.e2e.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'process.env is read only in packages/shared/src/config (FR-043)',
        },
      ],
    },
  },
  {
    // T052/T053, R-02, FR-026, quickstart 6. Never wait inside a job: a processor may not sleep,
    // poll or await external completion. Every long wait is a persisted state plus an inbound
    // callback (ADR 0003) — a processor that blocks instead is exactly the trap the constitution
    // names. Applies the moment any spec creates a `processors/` directory; no per-package
    // listing needed. `process.env` is repeated here rather than shared with the general block
    // above — see that block's comment.
    files: ['**/processors/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.e2e.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'process.env is read only in packages/shared/src/config (FR-043)',
        },
        {
          selector: 'CallExpression[callee.name=/^(setTimeout|setInterval)$/]',
          message:
            'a processor may not sleep or poll — persist a state plus an inbound callback instead (ADR 0003, R-02)',
        },
        {
          selector: 'WhileStatement[test.value=true]',
          message:
            'a processor may not poll in a loop — persist a state plus an inbound callback instead (ADR 0003, R-02)',
        },
      ],
    },
  },
  // T035 R-01's "cross-module reach by relative path" rule was removed here — see
  // QUESTIONS.md. A relative-import-depth pattern cannot distinguish a legitimate deep import
  // within one's own package (`application/commands/x.ts` importing `../../domain/y.js`, which
  // 001's own planned layout uses) from an escape into a sibling package, because both have the
  // same shape from a similarly nested file. Confirmed reachable: it flagged
  // `packages/shared/src/tenancy/deep/x.ts` importing `../../errors/index.js`, still inside
  // `packages/shared`. The real, structural version of this guarantee already exists —
  // `moduleResolution: NodeNext` plus each package's `exports` map rejects an import of another
  // package's undeclared subpath at typecheck (T002) — a path-resolving rule
  // (`eslint-plugin-boundaries`) would be the correct lint-time addition, and that is a new
  // dependency, ADR territory, not a string pattern.
  {
    // Gate scripts and tests run on a terminal, where stdout is the product.
    files: ['scripts/**/*.mjs', '**/*.test.ts', 'vitest.config.ts'],
    rules: { 'no-console': 'off' },
  },
);
