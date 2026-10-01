import type { ProvenanceClass } from './provenance.js';

/**
 * R-15's `provenance_base` table (research.md § R-15) — one row per closed provenance class, the
 * starting point of `confidence = min(100, provenance_base + observation_term - staleness_term)`.
 * Deliberately a *different* mapping from `provenance-strength.ts`'s ordinals: strength ranks
 * provenance classes against each other (R-03), confidence estimates how sure a single element
 * is (R-15) — two different questions that happen to share a domain.
 *
 * ponytail: Phase 3 computes confidence as `provenance_base` alone — `observation_term` (volume)
 * and `staleness_term` (recency) are T039 (Phase 4, R-15/FR-006 "a single observation is an
 * observation, not a fact"). Upgrade when T039 lands; until then every element's confidence is
 * exactly its class's base, which is a legitimate (if conservative) value of the full formula
 * with both terms at 0.
 */
export const CONFIDENCE_PROVENANCE_BASE_V1: Readonly<Record<ProvenanceClass, number>> = {
  human_confirmed: 90,
  human_authored: 85,
  derived_from_trace: 70,
  derived_from_runtime: 65,
  derived_from_code: 60,
  derived_from_config: 50,
  inferred_from_convention: 20,
};

/** The one call site: diff-builder.ts, when it stamps a new or changed element's confidence. */
export function provenanceBaseConfidence(provenance: ProvenanceClass): number {
  return CONFIDENCE_PROVENANCE_BASE_V1[provenance];
}
