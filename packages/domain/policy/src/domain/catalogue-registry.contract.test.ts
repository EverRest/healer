import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEED_POLICY_ACTIONS } from './policy-action-repository.js';

// T084: 010's action catalogue and 002's `policy_action` registry are two statements of one
// closed list. Compared in both directions so a key misspelled on either side fails.
const CATALOGUE = fileURLToPath(
  new URL(
    '../../../../../specs/010-safe-remediation/contracts/action-catalogue.md',
    import.meta.url,
  ),
);
// The action keys of the "The six actions" section: every `###` heading in it must be a backticked
// key, so a heading-format change (or a key without backticks) fails loudly, never silently drops.
export function parseCatalogueKeys(markdown: string): string[] {
  const section = /^## The six actions\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1];
  if (section === undefined) throw new Error('catalogue section "## The six actions" not found');
  return [...section.matchAll(/^### (.+)$/gm)].map((m) => {
    const key = /^`([^`]+)`/.exec(m[1] as string)?.[1];
    if (key === undefined)
      throw new Error(`catalogue heading is not a backticked key: ### ${m[1]}`);
    return key;
  });
}

const catalogueKeys = parseCatalogueKeys(readFileSync(CATALOGUE, 'utf8'));

describe('parseCatalogueKeys', () => {
  const doc = (heading: string) =>
    `# C\n\n## The six actions\n\n${heading}\n\n## Next\n\n### Not a key\n`;

  it('reads keys, ignoring headings outside the section', () => {
    expect(parseCatalogueKeys(doc('### `a.b` — undo only'))).toEqual(['a.b']);
  });

  it('fails on a heading without backticks, naming it', () => {
    expect(() => parseCatalogueKeys(doc('### a.b'))).toThrow('### a.b');
  });

  it('fails when the section is missing', () => {
    expect(() => parseCatalogueKeys('# C\n')).toThrow('not found');
  });
});

describe('010 action catalogue <-> policy_action registry (T084)', () => {
  it('parses the catalogue (a heading-format change must not make this vacuous)', () => {
    expect(catalogueKeys.length).toBeGreaterThan(0);
  });

  it('registers every catalogue key as a mutating reversible_remediation action owned by 010', () => {
    const missing = catalogueKeys.filter(
      (key) =>
        !SEED_POLICY_ACTIONS.some(
          (a) =>
            a.actionKey === key &&
            a.actionClass === 'reversible_remediation' &&
            a.mutating &&
            a.owningSpec === '010',
        ),
    );
    expect(missing).toEqual([]);
  });

  it('has no 010-owned registry key absent from the catalogue', () => {
    const extra = SEED_POLICY_ACTIONS.filter(
      (a) => a.owningSpec === '010' && !catalogueKeys.includes(a.actionKey),
    ).map((a) => a.actionKey);
    expect(extra).toEqual([]);
  });
});
