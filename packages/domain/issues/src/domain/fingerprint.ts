import { createHash } from 'node:crypto';

/**
 * Fingerprint normalisation, as versioned data (001 T016/T017, R-01, FR-003).
 *
 * The rule set is *data*, not code (001 T011's `normalisation_ruleset` table): an ordered list
 * of regex sources, each applied to every free-text field before hashing. Data rather than a
 * hardcoded function is what R-01 actually asks for — "the fingerprint can be explained and
 * recomputed" a year later means the rules that produced it are a value you can read back, not
 * a function whose behaviour at the time is lost the day it's edited.
 */
export interface NormalisationRules {
  /** Regex sources (no flags — always applied globally, case-insensitively), in order. A match
   *  is replaced with a single `*`, so two differently-shaped volatile values collapse to the
   *  same normalised text rather than merely being removed (removal could coincidentally align
   *  two *different* failures that both happened to drop out at the same position). */
  readonly stripPatterns: readonly string[];
}

/**
 * Seed rules — identifiers (UUIDs and long numeric ids), memory addresses, ISO timestamps and a
 * generated-file `:line:column` suffix (FR-003's named categories). Published as
 * `normalisation_ruleset` version 1 wherever a tenant's first ruleset is seeded; this constant is
 * not itself read at fingerprint time — `computeFingerprint` takes whatever rules the caller
 * resolved from the repository, so a future version can change every pattern here without a code
 * change.
 */
export const DEFAULT_NORMALISATION_RULES: NormalisationRules = {
  stripPatterns: [
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', // uuid
    '0x[0-9a-f]+', // memory address
    '\\d{4}-\\d{2}-\\d{2}t\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?z?', // iso timestamp
    ':\\d+:\\d+\\)?$', // generated-file line:column, e.g. "(Checkout.java:42:7)"
    '\\b\\d{4,}\\b', // long numeric ids — a 3-digit code like "E500" or "404" survives
  ],
};

/** Applies every pattern in order; unmatched text is untouched. */
export function normalise(value: string, rules: NormalisationRules): string {
  let result = value.toLowerCase();
  for (const pattern of rules.stripPatterns) {
    result = result.replace(new RegExp(pattern, 'g'), '*');
  }
  return result;
}

/**
 * What a fingerprint is computed over (R-01): component, environment, normalised exception type,
 * normalised top frames, endpoint template and error code. `component` and `environment` are not
 * normalised — they are the caller's own identifiers, not volatile signal text.
 */
export interface FingerprintInput {
  readonly component: string;
  readonly environment: string;
  readonly exceptionType?: string;
  readonly frames?: readonly string[];
  readonly endpointTemplate?: string;
  readonly errorCode?: string;
}

const FIELD_SEPARATOR = '\u0000';

/** Deterministic — same input and rules always hash to the same fingerprint (SC-001's replay). */
export function computeFingerprint(input: FingerprintInput, rules: NormalisationRules): string {
  const parts = [
    input.component,
    input.environment,
    input.exceptionType ? normalise(input.exceptionType, rules) : '',
    (input.frames ?? []).map((frame) => normalise(frame, rules)).join(FIELD_SEPARATOR),
    input.endpointTemplate ? normalise(input.endpointTemplate, rules) : '',
    input.errorCode ?? '',
  ];
  return createHash('sha256').update(parts.join(FIELD_SEPARATOR)).digest('hex');
}
