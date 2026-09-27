import { describe, expect, it, vi } from 'vitest';
import type {
  NewNormalisationRuleset,
  NormalisationRuleset,
  NormalisationRulesetRepository,
} from './normalisation-ruleset.js';
import { publishNormalisationRules } from './publish-normalisation-rules.js';

/**
 * The repository's own `publish` stays generic (`rules: unknown` — its e2e test legitimately
 * publishes shapes that are not `NormalisationRules`, proving the repository's opaque-storage
 * contract). Validating the *fingerprinting* shape belongs at this layer instead, which is the
 * one that actually knows it — review finding: a bad ruleset (an uncompilable regex, or missing
 * `stripPatterns` entirely) previously broke every signal's fingerprinting the moment it became
 * `getLatest()`, discovered only once real traffic hit it, not when it was published.
 */
function fakeRepository(): NormalisationRulesetRepository & {
  published: NewNormalisationRuleset[];
} {
  const published: NewNormalisationRuleset[] = [];
  return {
    published,
    getByVersion: () => Promise.resolve(null),
    getLatest: () => Promise.resolve(null),
    publish: vi.fn((ruleset: NewNormalisationRuleset) => {
      published.push(ruleset);
      return Promise.resolve({
        version: 1,
        rules: ruleset.rules,
        publishedAt: new Date(),
        note: ruleset.note ?? null,
      } satisfies NormalisationRuleset);
    }),
  };
}

describe('publishNormalisationRules — validates before it ever reaches the database', () => {
  it('rejects a ruleset with no stripPatterns array at all', async () => {
    const repo = fakeRepository();
    await expect(
      publishNormalisationRules(repo, { stripPatterns: undefined as never }),
    ).rejects.toThrow(/stripPatterns/);
    expect(repo.published).toEqual([]);
  });

  it('rejects a ruleset containing a pattern that does not compile as a regex', async () => {
    const repo = fakeRepository();
    await expect(publishNormalisationRules(repo, { stripPatterns: ['(unclosed'] })).rejects.toThrow(
      /regex/i,
    );
    expect(repo.published).toEqual([]);
  });

  it('publishes a ruleset whose every pattern compiles', async () => {
    const repo = fakeRepository();
    const result = await publishNormalisationRules(repo, { stripPatterns: ['\\d+'] }, 'note');
    expect(result.version).toBe(1);
    expect(repo.published).toEqual([{ rules: { stripPatterns: ['\\d+'] }, note: 'note' }]);
  });
});
