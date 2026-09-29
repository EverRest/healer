import type { ProvenanceClass } from './provenance.js';

/**
 * R-03's stored ordinal mapping. Named `_V1` so a future retune (stage 0 S0-4, once discovery
 * accuracy is measured) adds a `_V2` beside it rather than mutating this one — every already
 * -written `graph_node.strength` / `graph_edge.strength` / `edge_provenance.strength` was computed
 * from whichever table was current the day it was inserted, and must keep meaning that.
 */
export const PROVENANCE_STRENGTH_V1: Readonly<Record<ProvenanceClass, number>> = {
  human_confirmed: 70,
  human_authored: 65,
  derived_from_trace: 50,
  derived_from_runtime: 40,
  derived_from_code: 30,
  derived_from_config: 20,
  inferred_from_convention: 10,
};

/** The mapping this build ships. Retuning means adding `_V2` above and repointing this alias. */
export const CURRENT_PROVENANCE_STRENGTH = PROVENANCE_STRENGTH_V1;

/**
 * The ordinal for a provenance class, evaluated **only at insert time** (data-model.md,
 * "never recomputed on a schedule"). A repository calls this once, when writing a row, and
 * stores the result — it must never be called again to explain an already-persisted value, or a
 * query pinned at an old graph version (FR-014, SC-005) would answer with today's ordering
 * instead of the one that held when the row was written.
 *
 * `table` defaults to the mapping this build ships; a caller never needs to pass it explicitly
 * outside a test proving the ordinal is frozen at write time.
 */
export function provenanceStrength(
  provenance: ProvenanceClass,
  table: Readonly<Record<ProvenanceClass, number>> = CURRENT_PROVENANCE_STRENGTH,
): number {
  return table[provenance];
}
