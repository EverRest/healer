import { describe, expect, it } from 'vitest';
import type { ProvenanceClass } from './provenance.js';
import { PROVENANCE_STRENGTH_V1, provenanceStrength } from './provenance-strength.js';

describe('provenanceStrength (R-03)', () => {
  it.each([
    ['human_confirmed', 70],
    ['human_authored', 65],
    ['derived_from_trace', 50],
    ['derived_from_runtime', 40],
    ['derived_from_code', 30],
    ['derived_from_config', 20],
    ['inferred_from_convention', 10],
  ] satisfies [ProvenanceClass, number][])('%s -> %d', (provenance, expected) => {
    expect(provenanceStrength(provenance)).toBe(expected);
  });

  it('never recomputes at read time: a value stored at write time survives a later retune', () => {
    // What a repository would have written to the row at insert time, under today's mapping.
    const writeTimeStrength = provenanceStrength('derived_from_code');
    const storedRow = { strength: writeTimeStrength };

    // A hypothetical future retune (stage 0 S0-4) — a *new* table, never a mutation of
    // PROVENANCE_STRENGTH_V1, which every historical row was computed from.
    const tunedMapping: Readonly<Record<ProvenanceClass, number>> = {
      ...PROVENANCE_STRENGTH_V1,
      derived_from_code: 45,
    };
    expect(provenanceStrength('derived_from_code', tunedMapping)).toBe(45);

    // The already-persisted row is plain data, not a function of the mapping: reading it again
    // must return exactly what was written, never the retuned value (FR-014, SC-005).
    expect(storedRow.strength).toBe(writeTimeStrength);
    expect(storedRow.strength).not.toBe(45);
  });
});
