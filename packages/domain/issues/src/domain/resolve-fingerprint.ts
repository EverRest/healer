import {
  computeFingerprint,
  type FingerprintInput,
  type NormalisationRules,
} from './fingerprint.js';
import type { NormalisationRulesetRepository } from './normalisation-ruleset.js';

/**
 * No ruleset has ever been published. Fabricating a fallback here would let `issue.ruleset_version`
 * name a version that isn't real, exactly the guarantee 001 T011's FK exists to prevent — this is
 * an operational precondition (seed a ruleset before ingesting), not a case to paper over.
 */
export class NoNormalisationRulesetError extends Error {
  constructor() {
    super('cannot compute a fingerprint: no normalisation_ruleset has ever been published');
  }
}

/** A published row whose `rules` column isn't the shape this module knows how to apply. */
function parseRules(rules: unknown): NormalisationRules {
  if (
    typeof rules === 'object' &&
    rules !== null &&
    'stripPatterns' in rules &&
    Array.isArray((rules as { stripPatterns: unknown }).stripPatterns) &&
    (rules as { stripPatterns: unknown[] }).stripPatterns.every((p) => typeof p === 'string')
  ) {
    return rules as NormalisationRules;
  }
  throw new Error(
    `normalisation_ruleset row's "rules" column is not { stripPatterns: string[] }: ${JSON.stringify(rules)}`,
  );
}

export interface ResolvedFingerprint {
  readonly fingerprint: string;
  readonly rulesetVersion: number;
}

/**
 * T016's `computeFingerprint`, against whichever ruleset is *actually published* (001 T017,
 * R-01, FR-003) — never `DEFAULT_NORMALISATION_RULES` directly, so a fingerprint's recorded
 * `ruleset_version` always names a real row a historical recompute can look up again.
 */
export async function resolveFingerprint(
  rulesetRepo: NormalisationRulesetRepository,
  input: FingerprintInput,
): Promise<ResolvedFingerprint> {
  const ruleset = await rulesetRepo.getLatest();
  if (ruleset === null) throw new NoNormalisationRulesetError();
  const rules = parseRules(ruleset.rules);
  return { fingerprint: computeFingerprint(input, rules), rulesetVersion: ruleset.version };
}
