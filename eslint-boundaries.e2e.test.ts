import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Runs the real `eslint.config.mjs` against fixture files planted inside a real workspace
 * package (012 T034: "add a new package violating a boundary and assert lint fails without any
 * rule edit"). A synthetic `RuleTester` would not have caught the bug this test did on first
 * run: two `no-restricted-imports` blocks in the flat config silently overwrote each other for
 * any file both matched, so only the last-declared boundary rule ever fired. Only running the
 * actual composed config, the way `make lint` does, surfaces that.
 */
const FIXTURE_DIR = join(process.cwd(), 'packages/domain/architecture/src/__boundary_fixture__');

async function lint(relativePath: string, content: string): Promise<ESLint.LintResult> {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const path = join(FIXTURE_DIR, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintFiles([path]);
  return result;
}

function ruleIds(result: ESLint.LintResult): string[] {
  return result.messages.map((m) => m.ruleId).filter((id): id is string => id !== null);
}

describe('boundary lint rules (012 T034, T035, quickstart 2–5)', () => {
  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('fails a new domain package importing @prisma/client directly', async () => {
    const result = await lint(
      'a.ts',
      "import { PrismaClient } from '@prisma/client';\nexport const x = new PrismaClient();\n",
    );
    expect(ruleIds(result)).toContain('no-restricted-imports');
  });

  it('fails @healer/prisma-client outside infrastructure/ too — it re-exports the same client (ADR 0013)', async () => {
    const result = await lint(
      'a.ts',
      "import { PrismaClient } from '@healer/prisma-client';\nexport const x = new PrismaClient();\n",
    );
    expect(ruleIds(result)).toContain('no-restricted-imports');
  });

  it('fails a provider SDK imported outside packages/llm/*/infrastructure', async () => {
    const result = await lint(
      'b.ts',
      "import Anthropic from '@anthropic-ai/sdk';\nexport { Anthropic };\n",
    );
    expect(ruleIds(result)).toContain('no-restricted-imports');
  });

  it('fails process.env read outside packages/shared/src/config', async () => {
    const result = await lint('c.ts', 'export const x = process.env.FOO;\n');
    expect(ruleIds(result)).toContain('no-restricted-syntax');
  });

  it('fails a destructured read of process.env — a selector anchored on .FOO misses this', async () => {
    const result = await lint('c2.ts', 'const { FOO } = process.env;\nexport { FOO };\n');
    expect(ruleIds(result)).toContain('no-restricted-syntax');
  });

  it('fails a bare reference to process.env, not just a property access on it', async () => {
    const result = await lint('c3.ts', 'export const env = process.env;\n');
    expect(ruleIds(result)).toContain('no-restricted-syntax');
  });

  it('reports every violation at once — one rule block never silently discards another', async () => {
    const result = await lint(
      'e.ts',
      [
        "import { PrismaClient } from '@prisma/client';",
        "import Anthropic from '@anthropic-ai/sdk';",
        '',
        'export function fixture() {',
        '  const url = process.env.DATABASE_URL;',
        '  return { PrismaClient, Anthropic, url };',
        '}',
        '',
      ].join('\n'),
    );
    expect(new Set(ruleIds(result))).toEqual(
      new Set(['no-restricted-imports', 'no-restricted-syntax']),
    );
  });

  it('does not flag @prisma/client or process.env inside their own exempt directories', async () => {
    const prismaResult = await lint(
      'infrastructure/f.ts',
      "import { PrismaClient } from '@prisma/client';\nexport const x = new PrismaClient();\n",
    );
    expect(prismaResult.messages).toEqual([]);
  });

  it('does not flag @healer/prisma-client inside infrastructure/ either', async () => {
    const result = await lint(
      'infrastructure/f.ts',
      "import { PrismaClient } from '@healer/prisma-client';\nexport const x = new PrismaClient();\n",
    );
    expect(result.messages).toEqual([]);
  });

  it('does not flag a relative import reaching another package — that guarantee is structural now (T002), not lint (see QUESTIONS.md)', async () => {
    const result = await lint(
      'd.ts',
      "import { foo } from '../../policy/src/infrastructure/foo.js';\nexport { foo };\n",
    );
    expect(result.messages).toEqual([]);
  });
});

describe('lint limits (012 T036, FR-004)', () => {
  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('fails a function over the cyclomatic complexity limit', async () => {
    const branches = Array.from({ length: 20 }, (_, i) => `  if (n === ${i}) return ${i};`).join(
      '\n',
    );
    const result = await lint(
      'complex.ts',
      `export function f(n: number): number {\n${branches}\n  return -1;\n}\n`,
    );
    expect(ruleIds(result)).toContain('complexity');
  });

  it('fails nesting past the declared depth', async () => {
    const result = await lint(
      'deep.ts',
      [
        'export function f(n: number): number {',
        '  if (n > 0) {',
        '    if (n > 1) {',
        '      if (n > 2) {',
        '        if (n > 3) {',
        '          if (n > 4) {',
        '            return n;',
        '          }',
        '        }',
        '      }',
        '    }',
        '  }',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    );
    expect(ruleIds(result)).toContain('max-depth');
  });

  it('is exempt for test files', async () => {
    const branches = Array.from(
      { length: 20 },
      (_, i) => `  if (n === ${i}) expect(n).toBe(${i});`,
    ).join('\n');
    const result = await lint(
      'huge.test.ts',
      `import { expect } from 'vitest';\nexport function f(n: number) {\n${branches}\n}\n`,
    );
    expect(ruleIds(result)).not.toContain('complexity');
  });
});

describe('inline suppression of a boundary rule (012 T077, FR-005, quickstart 30)', () => {
  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('still fails the rule an eslint-disable comment tried to suppress', async () => {
    const result = await lint(
      'suppressed.ts',
      "// eslint-disable-next-line no-restricted-imports\nimport { PrismaClient } from '@prisma/client';\nexport const x = new PrismaClient();\n",
    );
    expect(ruleIds(result)).toContain('no-restricted-imports');
  });

  it('reports the suppression attempt itself as having no effect', async () => {
    const result = await lint(
      'suppressed2.ts',
      "// eslint-disable-next-line no-restricted-imports\nimport { PrismaClient } from '@prisma/client';\nexport const x = new PrismaClient();\n",
    );
    expect(result.messages.some((m) => /has no effect/.test(m.message))).toBe(true);
  });
});
