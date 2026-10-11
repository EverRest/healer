import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCode, stripComments } from './repo-scan.js';

// The shared gate stripper mis-reads the `/*` inside this regex literal as a comment opener.
const FIXTURE = [
  "export const t = (s: string) => s.replace(/\\/*$/, '');",
  "unwrapUntrusted(x, 'display');",
  "const k = 'knowledge:adopt';",
  "const e = { name: 'ExpectationAdopted' };",
  '/** a later JSDoc block */',
  'export {};',
].join('\n');

describe('stripComments (repo-scan)', () => {
  it('keeps code after a regex literal containing /*, up to a later JSDoc close', () => {
    const out = stripComments(FIXTURE);
    expect(out).toContain("unwrapUntrusted(x, 'display')");
    expect(out).toContain("'knowledge:adopt'");
    expect(out).toContain("name: 'ExpectationAdopted'");
    expect(out).not.toContain('later JSDoc');
  });

  it('blanks real comments, keeps offsets and newlines, ignores comment-only mentions', () => {
    const src =
      "// unwrapUntrusted here\nconst a = 1; /* knowledge:adopt */\n/** x\n y */\nconst b = '// not a comment';";
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toMatch(/unwrapUntrusted|knowledge:adopt/);
    expect(out).toContain("'// not a comment'");
  });

  it('readCode applies it to code files and leaves other files raw', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-scan-'));
    writeFileSync(join(root, 'a.ts'), FIXTURE);
    writeFileSync(join(root, 'b.sql'), '-- knowledge:adopt');
    mkdirSync(join(root, 'c'));
    expect(readCode(root, 'a.ts')).toContain("unwrapUntrusted(x, 'display')");
    expect(readCode(root, 'b.sql')).toContain('knowledge:adopt');
  });
});
