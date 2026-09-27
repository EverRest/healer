/**
 * Versioned data (001 T011, R-01): "never edited; a change is a new version" (data-model.md),
 * enforced by the database (append-only trigger, migration `20260927020000`) as well as by this
 * interface never exposing an update. Not tenant-scoped — one ruleset governs fingerprinting for
 * every tenant; the row itself carries no `tenant_id`.
 */
export interface NormalisationRuleset {
  readonly version: number;
  /** Shape owned by whichever rule strips volatile signal parts (001 T017, FR-003), not this type. */
  readonly rules: unknown;
  readonly publishedAt: Date;
  readonly note: string | null;
}

/** What a caller supplies to publish a new version — the repository assigns the version itself. */
export interface NewNormalisationRuleset {
  readonly rules: unknown;
  readonly note?: string;
}

/**
 * Read plus publish only — there is no update (R-01). `publish` always mints the next version;
 * it can never target an existing one, so "edit a published ruleset" has no method to call.
 */
export interface NormalisationRulesetRepository {
  getByVersion(version: number): Promise<NormalisationRuleset | null>;
  getLatest(): Promise<NormalisationRuleset | null>;
  publish(ruleset: NewNormalisationRuleset): Promise<NormalisationRuleset>;
}
