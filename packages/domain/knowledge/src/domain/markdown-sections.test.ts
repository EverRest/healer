import { describe, expect, it } from 'vitest';
import { MAX_SECTION_CHARS, splitSections, TooManySectionsError } from './markdown-sections.js';

const MIB = 1024 * 1024;
const timed = <T>(fn: () => T): { out: T; ms: number } => {
  const t = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t };
};

describe('splitSections resource bounds', () => {
  it('hits the section cap on a 1 MiB file of tiny sections, fast, without building them all', () => {
    const text = '# a\n'.repeat(MIB / 4);
    const { ms } = timed(() => {
      expect(() => splitSections(text, 0, 5000)).toThrow(TooManySectionsError);
    });
    expect(ms).toBeLessThan(1000);
  });

  it('is linear on a 1 MiB line of alternating spaces and hashes (no regex backtracking)', () => {
    const text = `# a${' #'.repeat(MIB / 2)}x\n`;
    const { out, ms } = timed(() => splitSections(text, 0, 5000));
    expect(ms).toBeLessThan(1000);
    expect(out.length).toBeGreaterThan(0);
  });

  it('is linear on 1 MiB without a heading (split at the bound, not per character)', () => {
    const { out, ms } = timed(() => splitSections('x\n'.repeat(MIB / 2), 0, 5000));
    expect(ms).toBeLessThan(1000);
    expect(out.length).toBe(Math.ceil(MIB / MAX_SECTION_CHARS));
  });

  it('counts split pieces and ignores blank sections', () => {
    expect(() => splitSections('# a\n# b\n# c\n', 0, 2)).toThrow(TooManySectionsError);
    expect(splitSections('# a\n# b\n', 0, 2)).toHaveLength(2);
    expect(splitSections('\n\n# a\n', 0, 1)).toHaveLength(1);
  });
});

describe('splitSections (T017)', () => {
  const text = 'intro\n\n# A\none\n## B\ntwo\n```\n# not a heading\n```\n# C\nthree\n';

  it('never spans a heading, keeps heading paths, and offsets address the file text', () => {
    const s = splitSections(text, 0);
    expect(s.map((x) => x.headingPath)).toEqual([[], ['A'], ['A', 'B'], ['C']]);
    for (const x of s) expect(text.slice(x.charStart, x.charEnd)).toBe(x.content);
    expect(s.map((x) => x.ordinal)).toEqual([0, 1, 2, 3]);
    expect(s[2]!.content).toContain('# not a heading'); // fenced: not a heading
  });

  it('splits an over-long section at the bound under one heading path', () => {
    const long = `# H\n${'x'.repeat(MAX_SECTION_CHARS * 2 + 10)}\n`;
    const s = splitSections(long, 0);
    expect(s.length).toBe(3);
    expect(s.every((x) => x.content.length <= MAX_SECTION_CHARS)).toBe(true);
    expect(s.every((x) => x.headingPath.join('/') === 'H')).toBe(true);
    expect(s.map((x) => x.content).join('')).toBe(long);
  });

  it('does not cut a surrogate pair', () => {
    const s = splitSections(`# H\n${'😀'.repeat(MAX_SECTION_CHARS)}`, 0);
    expect(s.map((x) => x.content).join('')).toBe(`# H\n${'😀'.repeat(MAX_SECTION_CHARS)}`);
    for (const x of s) expect(/[\ud800-\udbff]$/.test(x.content)).toBe(false);
  });

  it('closes a fence only on the same character, at least as long as the opener', () => {
    const cases: [string, string][] = [
      // a longer fence shows markdown containing a shorter fence
      ['````md\n```\n# in nested\n```\n# still inside\n````\n# Real\n', 'Real'],
      // tilde does not close backtick, and vice versa
      ['```\n~~~\n# inside\n~~~\n```\n# Real\n', 'Real'],
      ['~~~\n```\n# inside\n```\n~~~\n# Real\n', 'Real'],
      // a shorter run does not close a longer opener
      ['~~~~\n~~~\n# inside\n~~~~\n# Real\n', 'Real'],
    ];
    for (const [text, last] of cases) {
      const heads = splitSections(text, 0).flatMap((s) => s.headingPath);
      expect(heads, text).toEqual([last]);
    }
    // an unclosed fence swallows the rest: nothing after it is a heading
    expect(splitSections('```\n# a\n# b\n', 0).flatMap((s) => s.headingPath)).toEqual([]);
  });

  it('keeps offsets exact for CRLF and multibyte text', () => {
    const t = '# Ä\r\nzażółć 😀\r\n## B\r\n```\r\n# no\r\n```\r\ndone\r\n';
    const s = splitSections(t, 0);
    expect(s.map((x) => x.headingPath)).toEqual([['Ä'], ['Ä', 'B']]);
    for (const x of s) expect(t.slice(x.charStart, x.charEnd)).toBe(x.content);
    expect(s.map((x) => x.content).join('')).toBe(t);
  });

  it('starts after the front matter and drops blank sections', () => {
    const t = '---\nf: 1\n---\n\n\n# A\nbody\n';
    const s = splitSections(t, 13);
    expect(s.map((x) => x.headingPath)).toEqual([['A']]);
  });
});
