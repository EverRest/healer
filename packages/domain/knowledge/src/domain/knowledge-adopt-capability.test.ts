import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCode, REPO_ROOT, walkRepo } from '../testing/repo-scan.js';
import { KNOWLEDGE_ADOPT_CAPABILITY } from './capabilities.js';

/**
 * 005 T016 (FR-011, R-02, R-16). What this delivers: a TEXTUAL scan of the repository's code,
 * schema, migrations and generated OpenAPI document for the capability and for adopt routes/tools.
 * It is a drift detector, not the security boundary: no credential registry exists yet (002-policy
 * owns it; see capabilities.ts for what will enforce it), and dynamic construction
 * (`'knowledge:' + 'adopt'`) is not recognised.
 *
 * Scope: apps/, packages/, scripts/, prisma/ — code (ts/tsx/mts/cts/js/mjs/cjs), .sql, .prisma,
 * .json, .yaml. Comments are stripped from code files with a TypeScript-parser stripper (testing/repo-scan.ts)
 * so a JSDoc mention needs no allowlist entry. `*.test.ts` files
 * are excluded BY CHOICE: tests state the forbidden strings as fixtures, and a test is not a
 * credential or a route. specs/ is not scanned (the deferred declaration lives there).
 */

/** Files allowed to reference the capability. Empty today; the credential registry (002) and the
 *  future adopt endpoint's guard are added here deliberately when they exist. */
const CAPABILITY_ALLOWLIST: readonly string[] = [];
const DECLARING_FILE = 'packages/domain/knowledge/src/domain/capabilities.ts';
const ROOTS = ['apps', 'packages', 'scripts', 'prisma'];
const FILES = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sql|prisma|json|ya?ml)$/;

const CAPABILITY_REFERENCE = /knowledge:adopt|KNOWLEDGE_ADOPT_CAPABILITY/;
// A route decorator whose path or controller prefix mentions adopt (`@Post(':id/adopt')`).
const ADOPT_ROUTE = /@(?:Get|Post|Put|Patch|Delete|All|Controller)\s*\([^)]*adopt/i;
const MCP_ROOT = 'apps/mcp-server';
const OPENAPI_JSON = 'apps/api/openapi.json';

export interface Scan {
  readonly files: string[];
  readonly capabilityReferences: string[];
  readonly adoptRoutes: string[];
  readonly mcpAdoption: string[];
  readonly openApiAdoptPaths: string[];
}

export async function scanRepo(
  repoRoot: string,
  needles: readonly string[] | undefined = ['adopt'],
): Promise<Scan> {
  const files = walkRepo(repoRoot, ROOTS, FILES).filter((f) => f !== DECLARING_FILE);
  const text = new Map(files.map((f) => [f, readCode(repoRoot, f, needles)]));
  const withText = (pred: (f: string, t: string) => boolean): string[] =>
    files.filter((f) => pred(f, text.get(f) ?? ''));
  let openApiAdoptPaths: string[] = [];
  try {
    const doc = JSON.parse(readFileSync(join(repoRoot, OPENAPI_JSON), 'utf8')) as {
      paths?: Record<string, unknown>;
    };
    openApiAdoptPaths = Object.keys(doc.paths ?? {}).filter((p) => /adopt/i.test(p));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // no generated document yet is fine
  }
  return {
    files,
    capabilityReferences: withText(
      (f, t) => !CAPABILITY_ALLOWLIST.includes(f) && CAPABILITY_REFERENCE.test(t),
    ),
    adoptRoutes: withText((f, t) => /\.[cm]?tsx?$/.test(f) && ADOPT_ROUTE.test(t)),
    mcpAdoption: withText((f, t) => f.startsWith(`${MCP_ROOT}/`) && /adopt/i.test(t)),
    openApiAdoptPaths,
  };
}

describe('knowledge:adopt textual scan (005 T016, R-16; no credential registry exists yet)', () => {
  it('is the literal string the spec names', () => {
    expect(KNOWLEDGE_ADOPT_CAPABILITY).toBe('knowledge:adopt');
  });

  it('reads the real repository (sentinel + size), not an empty tree', async () => {
    const { files } = await scanRepo(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('apps/api/src/main.ts');
    expect(files).toContain('prisma/schema.prisma');
  });

  it('the capability appears in no code, schema, migration or script outside its declaration', async () => {
    expect((await scanRepo(REPO_ROOT)).capabilityReferences).toEqual([]);
  });

  it('no controller declares an adopt route and no MCP file mentions adoption', async () => {
    const s = await scanRepo(REPO_ROOT);
    expect(s.adoptRoutes).toEqual([]);
    expect(s.mcpAdoption).toEqual([]);
  });

  it('the generated OpenAPI document has no path containing adopt', async () => {
    expect((await scanRepo(REPO_ROOT)).openApiAdoptPaths).toEqual([]);
  });

  it('a missing scan root is a failure, not an empty result', () => {
    const empty = mkdtempSync(join(tmpdir(), 'adopt-empty-'));
    expect(() => walkRepo(empty, ROOTS, FILES)).toThrow(/ENOENT/);
  });

  it(
    'the prefilter does not change the result (real repo and regex-literal fixture)',
    { timeout: 60_000 },
    async () => {
      const fast = await scanRepo(REPO_ROOT);
      const full = await scanRepo(REPO_ROOT, undefined);
      expect(fast).toEqual(full);
      const root = mkdtempSync(join(tmpdir(), 'adopt-pf-'));
      for (const r of ROOTS) mkdirSync(join(root, r), { recursive: true });
      mkdirSync(join(root, 'packages/a'), { recursive: true });
      writeFileSync(
        join(root, 'packages/a/rx.ts'),
        "export const t = (s: string) => s.replace(/\\/*$/, '');\nconst c = 'knowledge:adopt';\n/** end */",
      );
      writeFileSync(join(root, 'packages/a/none.ts'), 'export const z = 1;');
      expect((await scanRepo(root)).capabilityReferences).toEqual(['packages/a/rx.ts']);
      expect(await scanRepo(root)).toEqual(await scanRepo(root, undefined));
    },
  );

  it('mutation check: the scanner flags injected entries and ignores comment mentions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adopt-scan-'));
    const put = (rel: string, body: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    for (const r of ROOTS) mkdirSync(join(root, r), { recursive: true });
    put('packages/agents/src/creds.ts', "export const caps = ['knowledge:adopt'];");
    put('prisma/migrations/x/migration.sql', "INSERT INTO caps VALUES ('knowledge:adopt');");
    put('apps/api/src/x.controller.ts', "@Post(':id/adopt')\nadopt() {}");
    put('apps/mcp-server/src/tools.ts', "tools.register('adopt_expectation')");
    put('apps/api/src/ok.controller.ts', "@Post(':id/revoke')\nrevoke() {}");
    put('packages/x/src/doc.ts', '/** mentions knowledge:adopt in a comment only */\nexport {};');
    put(OPENAPI_JSON, JSON.stringify({ paths: { '/expectations/{id}/adopt': {} } }));
    const s = await scanRepo(root);
    expect(s.capabilityReferences.sort()).toEqual([
      'packages/agents/src/creds.ts',
      'prisma/migrations/x/migration.sql',
    ]);
    expect(s.adoptRoutes).toEqual(['apps/api/src/x.controller.ts']);
    expect(s.mcpAdoption).toEqual(['apps/mcp-server/src/tools.ts']);
    expect(s.openApiAdoptPaths).toEqual(['/expectations/{id}/adopt']);
  });
});
