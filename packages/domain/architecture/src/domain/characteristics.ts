/**
 * The `characteristics` vocabulary (FR-001, D-09, data-model.md `component_attr`): an OPEN set,
 * widened by configuration — a value handed to `parseCharacteristicVocabulary` at the composition
 * root — never by a migration. The column is `text[]`, so the database never needs to know it.
 */
export const DEFAULT_CHARACTERISTICS = [
  'stateful',
  'user_facing',
  'money_path',
  'public_contract',
  'scheduled',
  'third_party',
  'event_driven',
] as const;

const TERM = /^[a-z][a-z0-9_]{0,63}$/;

declare const vocabularyBrand: unique symbol;

/** Only `parseCharacteristicVocabulary` produces one, so an unvalidated list cannot be passed on. */
export interface CharacteristicVocabulary {
  readonly terms: ReadonlySet<string>;
  readonly [vocabularyBrand]: true;
}

export class CharacteristicVocabularyError extends Error {
  constructor(detail: string) {
    super(`Invalid characteristic vocabulary: ${detail}`);
    this.name = 'CharacteristicVocabularyError';
  }
}

/** Fails fast at start-up on a malformed config value, like `loadConfig`. */
export function parseCharacteristicVocabulary(raw: unknown): CharacteristicVocabulary {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new CharacteristicVocabularyError('expected a non-empty array');
  const terms = new Set<string>();
  for (const term of raw as unknown[]) {
    if (typeof term !== 'string' || !TERM.test(term))
      throw new CharacteristicVocabularyError(`${JSON.stringify(term)} is not a snake_case term`);
    if (terms.has(term)) throw new CharacteristicVocabularyError(`duplicate term ${term}`);
    terms.add(term);
  }
  return { terms } as unknown as CharacteristicVocabulary;
}

export function defaultCharacteristicVocabulary(): CharacteristicVocabulary {
  return parseCharacteristicVocabulary(DEFAULT_CHARACTERISTICS);
}
