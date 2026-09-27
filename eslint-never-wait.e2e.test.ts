import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Never wait inside a job (012 T052, T053, R-02, FR-026, quickstart 6) — run against the real
 * composed config, the same way `eslint-boundaries.e2e.test.ts` caught the T035 rule-collision
 * bug. `no-restricted-syntax` has no per-rule-name trick to dodge that collision, so this test
 * also stands as the regression guard for the disjoint-file-scoping fix in eslint.config.mjs.
 *
 * The fixture lives in a `__never_wait_fixture__` subdirectory, not directly in
 * `packages/workflow/src/processors/` — `afterEach` deletes this directory recursively, and the
 * real `processors/` directory a later spec creates must survive that deletion untouched.
 */
const FIXTURE_DIR = join(process.cwd(), 'packages/workflow/src/processors/__never_wait_fixture__');

async function lint(relativePath: string, content: string): Promise<ESLint.LintResult> {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const path = join(FIXTURE_DIR, relativePath);
  writeFileSync(path, content);
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintFiles([path]);
  return result;
}

function ruleIds(result: ESLint.LintResult): string[] {
  return result.messages.map((m) => m.ruleId).filter((id): id is string => id !== null);
}

describe('never-wait-inside-a-job lint rule (012 T052, T053, quickstart 6)', () => {
  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('fails a processor that sleeps', async () => {
    const result = await lint(
      'sleeper.ts',
      'export async function run() {\n  await new Promise((r) => setTimeout(r, 30_000));\n}\n',
    );
    expect(ruleIds(result)).toContain('no-restricted-syntax');
  });

  it('fails a processor with a poll loop', async () => {
    const result = await lint(
      'poller.ts',
      'export async function run() {\n  while (true) {\n    if (await check()) break;\n  }\n}\ndeclare function check(): Promise<boolean>;\n',
    );
    expect(ruleIds(result)).toContain('no-restricted-syntax');
  });

  it('still enforces process.env confinement inside processors/', async () => {
    const result = await lint('env.ts', 'export const x = process.env.FOO;\n');
    expect(ruleIds(result)).toContain('no-restricted-syntax');
  });

  it('passes an ordinary processor that neither sleeps, polls, nor reads process.env', async () => {
    const result = await lint(
      'ok.ts',
      'export async function run(input: { id: string }) {\n  return { handled: input.id };\n}\n',
    );
    expect(result.messages).toEqual([]);
  });

  it('does not flag setTimeout outside a processors/ directory', async () => {
    const outsideDir = join(process.cwd(), 'packages/workflow/src/__not_a_processor__');
    mkdirSync(outsideDir, { recursive: true });
    const path = join(outsideDir, 'x.ts');
    writeFileSync(path, 'export function schedule() {\n  setTimeout(() => {}, 1000);\n}\n');
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintFiles([path]);
    rmSync(outsideDir, { recursive: true, force: true });
    expect(ruleIds(result)).not.toContain('no-restricted-syntax');
  });
});
