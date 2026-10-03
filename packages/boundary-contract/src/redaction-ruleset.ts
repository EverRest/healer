/**
 * The redaction ruleset's published definition (003 T017, FR-008, R-07a): immutable, versioned,
 * and applied only in the execution plane. The control plane keeps the definition so a snapshot's
 * redaction is explicable ("which detectors cleared this?"); it never sees a detection. The
 * detectors themselves are code shipped in the runner image, keyed by these names — a runner older
 * than `runnerMinImageVersion` cannot apply the version and therefore withholds (FR-009).
 *
 * The list is the one authority for detector names: the `collection_gap` shape names a failing
 * detector from it, so a gap says *which* detector failed rather than "redaction failed".
 */
export const DETECTOR_KEYS = [
  'private_key_block',
  'payment_instrument',
  'national_identifier',
  'connection_string',
  'bearer_token',
  'email_address',
  'uuid_in_message_position',
  'ip_address',
  'numeric_identifier_run',
  'free_text_span',
] as const;
export type DetectorKey = (typeof DETECTOR_KEYS)[number];

export interface RedactionRulesetDefinition {
  readonly version: number;
  /** Applied in this order: whole-item detectors first, so nothing sensitive is rewritten then sent. */
  readonly detectors: readonly DetectorKey[];
  readonly runnerMinImageVersion: string;
}

export const REDACTION_RULESETS: Readonly<Record<number, RedactionRulesetDefinition>> = {
  1: { version: 1, detectors: DETECTOR_KEYS, runnerMinImageVersion: '0.55.0' },
};

export const CURRENT_REDACTION_RULESET_VERSION = 1;
