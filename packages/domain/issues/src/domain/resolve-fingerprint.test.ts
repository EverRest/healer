import { describe, expect, it } from 'vitest';
import { resolveFingerprint, NoNormalisationRulesetError } from './resolve-fingerprint.js';
import type {
  NormalisationRuleset,
  NormalisationRulesetRepository,
} from './normalisation-ruleset.js';

/**
 * T017: normalisation implementing T016 against `normalisation_ruleset` (FR-003) — the fingerprint
 * is always computed against whichever version is *actually published*, never a hardcoded
 * default, so `issue.ruleset_version` names a real row (001 T011's FK) rather than a convenient
 * fiction.
 */
function repoReturning(ruleset: NormalisationRuleset | null): NormalisationRulesetRepository {
  return {
    getByVersion: async () => ruleset,
    getLatest: async () => ruleset,
    publish: async () => {
      throw new Error('not used in this test');
    },
  };
}

describe('resolveFingerprint (001 T017, R-01, FR-003)', () => {
  it('computes the fingerprint against the latest published ruleset and returns its version', async () => {
    const repo = repoReturning({
      version: 3,
      rules: { stripPatterns: ['0x[0-9a-f]+'] },
      publishedAt: new Date(),
      note: null,
    });
    const result = await resolveFingerprint(repo, {
      component: 'checkout-service',
      environment: 'prod',
      exceptionType: 'NullPointerException',
    });
    expect(result.rulesetVersion).toBe(3);
    expect(result.fingerprint).toHaveLength(64); // sha256 hex
  });

  it('refuses to fabricate a fingerprint when no ruleset has ever been published', async () => {
    const repo = repoReturning(null);
    await expect(
      resolveFingerprint(repo, { component: 'c', environment: 'prod' }),
    ).rejects.toBeInstanceOf(NoNormalisationRulesetError);
  });

  it('refuses a published ruleset row whose rules are not the shape this module expects', async () => {
    const repo = repoReturning({
      version: 1,
      rules: { notStripPatterns: [] },
      publishedAt: new Date(),
      note: null,
    });
    await expect(resolveFingerprint(repo, { component: 'c', environment: 'prod' })).rejects.toThrow(
      /stripPatterns/,
    );
  });

  it('the same signal against the same published version always resolves to the same fingerprint', async () => {
    const repo = repoReturning({
      version: 1,
      rules: { stripPatterns: [] },
      publishedAt: new Date(),
      note: null,
    });
    const input = { component: 'c', environment: 'prod', errorCode: 'E1' };
    const a = await resolveFingerprint(repo, input);
    const b = await resolveFingerprint(repo, input);
    expect(a).toEqual(b);
  });
});
