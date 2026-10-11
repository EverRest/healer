import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Shared by this package's structural tests (never exported from the package entry). One walk, so
 * the three scans cannot disagree about what "the repository" is. A missing root throws — a scan
 * that silently reads nothing proves nothing.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(
  /\/$/,
  '',
);

// `generated` is skipped at any depth (only prisma/generated exists today); a scan target named so would be missed.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'generated']);
export const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|e2e\.test)\.(?:ts|tsx|mts|cts)$/;

const walks = new Map<string, string[]>();

/**
 * Repo-relative paths under `roots` matching `include`; test files only when `includeTests`.
 * Memoised per (repoRoot, roots, include, includeTests) so scans in one test file share one walk;
 * a caller gets its own copy.
 */
export function walkRepo(
  repoRoot: string,
  roots: readonly string[],
  include: RegExp,
  includeTests = false,
): string[] {
  const key = [repoRoot, roots.join(','), include.source, includeTests].join('\0');
  const cached = walks.get(key);
  if (cached !== undefined) return [...cached];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (include.test(e.name) && (includeTests || !TEST_FILE.test(e.name))) {
        out.push(full.slice(repoRoot.length + 1));
      }
    }
  };
  for (const r of roots) walk(join(repoRoot, r)); // ENOENT propagates on purpose
  walks.set(key, out);
  return [...out];
}

/**
 * Blanks real comment ranges only, keeping offsets and newlines. Built on the TypeScript parser
 * (regex literals are tokenised correctly) rather than scripts/lib/strip-comments.mjs, whose
 * scanner loop never rescans `/` as a regex and so treats `/\/*$/` as a comment opener.
 */
export function stripComments(source: string, fileName = 'x.ts'): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const ranges = new Map<number, number>();
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      const found = [
        ...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []),
        ...(ts.getTrailingCommentRanges(source, node.getFullStart()) ?? []),
      ];
      for (const r of found) ranges.set(r.pos, r.end);
      return;
    }
    children.forEach(visit);
  };
  visit(sf);
  let out = source;
  for (const [pos, end] of ranges) {
    out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end);
  }
  return out;
}

const texts = new Map<string, string>();

/**
 * File text with comments removed for code files; raw for sql/prisma/json/yaml. With `needles`, a
 * code file whose raw text contains none of them (case-insensitive) returns '' without parsing:
 * such a file cannot hold a hit, so skipping the stripper is exact, while a file that only
 * mentions a needle in a comment still goes through it and is blanked. `needles` must cover every
 * alternative of the regex the caller applies to the result.
 */
export function readCode(repoRoot: string, rel: string, needles?: readonly string[]): string {
  const key = `${repoRoot}\0${rel}`;
  let raw = texts.get(key);
  if (raw === undefined) {
    raw = readFileSync(join(repoRoot, rel), 'utf8');
    texts.set(key, raw);
  }
  if (!CODE_FILE.test(rel)) return raw;
  if (needles !== undefined) {
    const lower = raw.toLowerCase();
    if (!needles.some((n) => lower.includes(n.toLowerCase()))) return '';
  }
  return stripComments(raw, rel);
}
