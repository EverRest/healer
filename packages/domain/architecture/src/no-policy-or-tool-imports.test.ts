import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 004 Phase 3, sub-batch C (T031, FR-026): "0 policy predicates evaluated / 0 tools called" is
 * proven structurally — the discovery application/domain modules import nothing from
 * `@healer/domain-policy`, `packages/agents`, `packages/llm` or any tool registry, so there is no
 * code path on which a policy predicate or a tool call could even be constructed, let alone
 * evaluated. A spy would have nothing to attach to (no such import exists to call through); this
 * is the honest proof the batch prompt asks for in place of one.
 *
 * `package.json`'s declared `dependencies` (checked in `design-partner-discovery.e2e.test.ts`) is
 * the stronger guarantee — pnpm's workspace linking means an undeclared package has no
 * `node_modules` symlink to resolve through at all, so this cannot be bypassed by editing source
 * without also editing `package.json`. This scan is the second, complementary signal: it also
 * catches a bypass that *does* declare the dependency.
 */

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));
const SCAN_DIRS = ['application', 'domain'];

// No `g`/`y` flag: `.test()` on a global regex mutates `lastIndex` across calls, which would
// silently skip matches on a later file in the same `.filter()` loop — exactly the kind of bug a
// gate script must not have. A fresh match per call needs no flag at all here.
const FORBIDDEN_IMPORT_PATTERN =
  /\b(?:from|import)\s*\(?\s*['"]@healer\/(domain-policy|agents|llm)['"]/;
// No leading/trailing `\b`: a camelCase identifier like `getToolRegistry` has no word boundary
// between "get" and "Tool" (both are word characters), so a boundary-anchored pattern would miss
// it — a plain case-insensitive substring is the honest (if coarser) match here.
const TOOL_REGISTRY_PATTERN = /tool[_-]?registry/i;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (extname(entry) === '.ts' && !entry.endsWith('.test.ts')) {
      yield full;
    }
  }
}

function collectSourceFiles(): { readonly path: string; readonly content: string }[] {
  const files: { path: string; content: string }[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(SRC_ROOT, dir))) {
      files.push({ path: file, content: readFileSync(file, 'utf8') });
    }
  }
  return files;
}

describe('discovery application/domain modules import nothing from policy, agents, llm or a tool registry (T031, FR-026)', () => {
  it('0 files under application/ or domain/ import @healer/domain-policy, @healer/agents or @healer/llm', () => {
    const files = collectSourceFiles();
    expect(files.length).toBeGreaterThan(0); // the scan itself must see real files, not an empty glob
    const hits = files.filter((f) => FORBIDDEN_IMPORT_PATTERN.test(f.content));
    expect(hits.map((f) => f.path)).toEqual([]);
  });

  it('0 files under application/ or domain/ reference a tool registry by name', () => {
    const files = collectSourceFiles();
    const hits = files.filter((f) => TOOL_REGISTRY_PATTERN.test(f.content));
    expect(hits.map((f) => f.path)).toEqual([]);
  });

  // Mutation-check: the scan itself must be capable of catching the thing it claims to catch —
  // proven against a synthetic violation, not against this package's own (currently clean) source.
  it('mutation-check: the import pattern does catch a planted violation', () => {
    const planted = "import { evaluate } from '@healer/domain-policy';\nexport const x = 1;\n";
    expect(FORBIDDEN_IMPORT_PATTERN.test(planted)).toBe(true);
  });

  it('mutation-check: the tool-registry pattern does catch a planted violation', () => {
    const planted = 'const registry = getToolRegistry();\n';
    expect(TOOL_REGISTRY_PATTERN.test(planted)).toBe(true);
  });
});
