import type {
  NormalisationRuleset,
  NormalisationRulesetRepository,
} from './normalisation-ruleset.js';
import type { NormalisationRules } from './fingerprint.js';

/**
 * Validates a `NormalisationRules` value before it ever reaches `NormalisationRulesetRepository
 * .publish` — an invalid ruleset published straight through the generic repository would only
 * fail the moment `resolveFingerprint` reads it back via `getLatest()`, breaking every signal's
 * fingerprinting (and therefore all of ingestion) until someone notices and publishes a fix.
 */
export function validateNormalisationRules(rules: NormalisationRules): void {
  if (!Array.isArray(rules.stripPatterns)) {
    throw new Error('normalisation rules must declare a stripPatterns array');
  }
  for (const pattern of rules.stripPatterns) {
    try {
      RegExp(pattern);
    } catch {
      throw new Error(`normalisation rules pattern is not a valid regex: ${pattern}`);
    }
  }
}

export async function publishNormalisationRules(
  repository: NormalisationRulesetRepository,
  rules: NormalisationRules,
  note?: string,
): Promise<NormalisationRuleset> {
  validateNormalisationRules(rules);
  return repository.publish({ rules, ...(note !== undefined ? { note } : {}) });
}
