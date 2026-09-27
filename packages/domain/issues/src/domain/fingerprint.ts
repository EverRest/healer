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
 * generated-file `:line[:column]` suffix (FR-003's named categories). Published as
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
    ':\\d+(:\\d+)?\\)?$', // generated-file line[:column], e.g. "(Checkout.java:42:7)" or "(Checkout.java:42)"
    '\\b\\d{4,}\\b', // long numeric ids — a 3-digit code like "E500" or "404" survives
  ],
};

/** `stripPatterns` compiled once per `computeFingerprint` call rather than once per field — the
 * same five-or-so patterns were being re-parsed from source for every one of a signal's fields. */
function compilePatterns(rules: NormalisationRules): readonly RegExp[] {
  // `i`: the doc comment on `stripPatterns` always promised case-insensitive matching, but the
  // flag was missing — silently correct only because every seed pattern happens to be lowercase.
  // A ruleset version whose own pattern contains an uppercase literal would otherwise never match
  // the already-lowercased input below.
  return rules.stripPatterns.map((pattern) => new RegExp(pattern, 'gi'));
}

/** Applies every compiled pattern in order; unmatched text is untouched. */
function applyPatterns(value: string, patterns: readonly RegExp[]): string {
  let result = value.toLowerCase();
  for (const pattern of patterns) {
    result = result.replace(pattern, '*');
  }
  return result;
}

/** Applies every pattern in order; unmatched text is untouched. Compiles `rules` fresh — prefer
 * `computeFingerprint`, which compiles once for every field of a signal, when hashing. */
export function normalise(value: string, rules: NormalisationRules): string {
  return applyPatterns(value, compilePatterns(rules));
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

// R-01 says "normalised top frames", not "every frame" — a deep stack whose leaf frames wander
// (recursion, differing call depth into the same failure) would otherwise split one failure into
// many issues. Placeholder pending the stage-0 incident audit tuning this for real (same status
// as the excerpt-length limit elsewhere) — 5 matches common APM defaults and is at least a
// deliberate, documented number rather than "every frame, how many happen to arrive".
const MAX_FINGERPRINT_FRAMES = 5;

/**
 * Deterministic — same input and rules always hash to the same fingerprint (SC-001's replay).
 * Hashes structured JSON, not fields joined by a raw separator character: a joined string can't
 * tell "one frame that happens to contain the separator" apart from "two separate frames split at
 * it", which a NUL byte inside captured stack-trace text is a real way to hit.
 */
export function computeFingerprint(input: FingerprintInput, rules: NormalisationRules): string {
  const patterns = compilePatterns(rules);
  const parts = {
    component: input.component,
    environment: input.environment,
    exceptionType: input.exceptionType ? applyPatterns(input.exceptionType, patterns) : '',
    frames: (input.frames ?? [])
      .slice(0, MAX_FINGERPRINT_FRAMES)
      .map((frame) => applyPatterns(frame, patterns)),
    endpointTemplate: input.endpointTemplate ? applyPatterns(input.endpointTemplate, patterns) : '',
    errorCode: input.errorCode ?? '',
  };
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
