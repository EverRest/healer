import { describe, expect, it } from 'vitest';
import { stripComments } from './strip-comments.mjs';

describe('stripComments (shared by every textual gate)', () => {
  it('strips a line comment, keeping the code before it', () => {
    expect(stripComments('const x = 1; // trailing comment\n')).toBe('const x = 1; \n');
  });

  it('strips a block comment, replacing it with matching blank lines so line numbers survive', () => {
    const source = 'const a = 1;\n/* line 2\nline 3\nline 4 */\nconst b = 2;\n';
    const stripped = stripComments(source);
    expect(stripped).toBe('const a = 1;\n\n\n\nconst b = 2;\n');
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
  });

  /**
   * The concrete bypass a review reproduced against the naive `.replace(/\/\/.*$/gm, '')`
   * version: an ordinary URL string earlier on the same line made the regex treat everything after
   * its `//` as removed, hiding a confirm-shaped registration from every gate that scans stripped
   * text. `ts.createScanner` tokenizes the string literal as one token before comment detection
   * ever looks inside it, so this must now survive intact.
   */
  it('does not treat "//" inside a string literal as a comment start (the reproduced bypass)', () => {
    const source =
      'const base = "https://example.com"; registerTool({ name: "graph_confirm_draft" });\n';
    expect(stripComments(source)).toBe(source);
  });

  it('leaves a single-quoted string containing "//" untouched', () => {
    const source = "const base = 'https://example.com';\n";
    expect(stripComments(source)).toBe(source);
  });

  it('leaves a template literal containing "//" untouched, including its interpolation', () => {
    const source = 'const url = `https://example.com/${path}`;\n';
    expect(stripComments(source)).toBe(source);
  });

  /**
   * A second, independently reproduced bug in the same rewrite: a bare `ts.createScanner().scan()`
   * loop does not know how to resume a template literal after the `}` that closes a `${...}`
   * substitution — only `reScanTemplateToken()` does, which needs the caller to track template
   * nesting itself. Without that tracking, everything *after* the first interpolated template in a
   * file gets mis-tokenized, including a later JSDoc comment's backtick-quoted words, which then
   * stops being recognised as a comment at all (reproduced against
   * packages/domain/evidence/src/domain/evidence-required.ts, which has exactly this shape: an
   * interpolated template, then a later block comment mentioning "Prisma").
   */
  it('resumes correctly after an interpolated template literal, keeping later comments strippable', () => {
    const source = [
      'function f(a: number, b: number) {',
      '  return `total: ${a + b} done`;',
      '}',
      '/**',
      ' * mentions Prisma inside a comment, after the template above',
      ' */',
      'const x = 1;',
      '',
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).not.toContain('Prisma');
    expect(stripped).toContain('return `total: ${a + b} done`;');
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('handles two interpolated templates and a nested object literal inside a substitution', () => {
    const source =
      'const a = `${x} and ${y}`; const b = `${({ z }).z}`; // trailing\nconst c = 1;\n';
    const stripped = stripComments(source);
    expect(stripped).toBe('const a = `${x} and ${y}`; const b = `${({ z }).z}`; \nconst c = 1;\n');
  });

  it('still strips a real comment that follows a string on the same line', () => {
    const source = 'const base = "https://example.com"; // now a real trailing comment\n';
    expect(stripComments(source)).toBe('const base = "https://example.com"; \n');
  });

  it('ignores a comment marker written inside a comment (still stripped as one comment)', () => {
    expect(stripComments('// this mentions /* nested */ markers\nconst x = 1;\n')).toBe(
      '\nconst x = 1;\n',
    );
  });
});
