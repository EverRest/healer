import type { FrontMatterErrorKind } from '../domain/front-matter.js';

/**
 * Broken files for the T018 tests (unit and e2e share them). Each violates exactly ONE rule: every
 * other field is valid, so the asserted `kind` names the one cause and a case cannot pass because
 * some unrelated rule happened to reject it.
 */
const wrap = (yaml: string) => `---\n${yaml}\n---\n## Body\n`;
const VALID = 'feature: f\ncomponent: c\n';
const ONE = '  - { id: a-1, description: x }';

export const BROKEN_FRONT_MATTER: Record<string, { text: string; kind: FrontMatterErrorKind }> = {
  'no front matter': { text: '## just prose\n', kind: 'missing' },
  unterminated: {
    text: `---\n${VALID}expected_behaviors:\n${ONE}\n\n## Body\n`,
    kind: 'unterminated',
  },
  'tab indentation': {
    text: wrap(`${VALID}expected_behaviors:\n\t- { id: a-1, description: x }`),
    kind: 'tab_indent',
  },
  'duplicate keys': { text: wrap(`${VALID}feature: other`), kind: 'duplicate_key' },
  'unresolved tag': {
    text: wrap('feature: !!js/function "function(){}"\ncomponent: c'),
    kind: 'unresolved_tag',
  },
  // Valid keys and shapes; only the number of aliases is wrong (the library's own ratio guard does
  // not fire on this small output, so this pins the explicit maxAliasCount of ADR 0017).
  'alias bomb (more than 10 aliases)': {
    text: wrap(
      `${VALID}expected_behaviors:\n  - { id: e0, description: &d text }\n${Array.from(
        { length: 12 },
        (_, i) => `  - { id: e${i + 1}, description: *d }`,
      ).join('\n')}`,
    ),
    kind: 'alias_limit',
  },
  // Valid keys; a 70 KB comment is the only fault, and a comment cannot fail any other rule.
  'oversize block': {
    text: wrap(`${VALID}expected_behaviors:\n${ONE}\n# ${'x'.repeat(70_000)}`),
    kind: 'size',
  },
  'wrong type (id is a number)': {
    text: wrap(`${VALID}expected_behaviors:\n  - { id: 12, description: d }`),
    kind: 'schema',
  },
  'wrong type (int given as string)': {
    text: wrap(`${VALID}constraints:\n  a: { type: int, value: "3" }`),
    kind: 'schema',
  },
  'duplicate expectation ids': {
    text: wrap(
      `${VALID}expected_behaviors:\n  - { id: a-1, description: x }\n  - { id: a-1, description: y }`,
    ),
    kind: 'schema',
  },
  'unknown constraint type': {
    text: wrap(`${VALID}constraints:\n  a: { type: float, value: 1 }`),
    kind: 'schema',
  },
  'bad duration': {
    text: wrap(`${VALID}constraints:\n  a: { type: duration, value: soon }`),
    kind: 'duration',
  },
  'self-reported authorship (unknown key)': {
    text: wrap(`${VALID}author: mallory\nmodified: 2001-01-01`),
    kind: 'schema',
  },
  'self-reported freshness inside a constraint': {
    text: wrap(`${VALID}constraints:\n  a: { type: int, value: 1, sourceModifiedAt: 2001-01-01 }`),
    kind: 'schema',
  },
};
