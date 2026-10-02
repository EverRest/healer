import { describe, expect, it } from 'vitest';
import {
  DEGRADATION_ORDER,
  EXHAUSTED_ENTRY,
  degradationStepOf,
  entryForStep,
  stepsToMark,
} from './degradation.js';

// T063 (FR-012, R-12): `degradation_step` is the count of soft thresholds crossed by
// consumed / limit — derived from the same aggregate, so it cannot disagree with the budget that
// caused it, and monotone within a period because consumption is.
describe('degradationStepOf', () => {
  const pcts = [50, 75, 90];

  it.each([
    [0, 0],
    [49.99, 0],
    [50, 1],
    [74.9, 1],
    [75, 2],
    [89, 2],
    [90, 3],
    [100, 3],
    [250, 3],
  ])('consumed %s of 100 → step %s', (consumed, step) => {
    expect(degradationStepOf(consumed, 100, pcts)).toBe(step);
  });

  it('is monotone in consumption', () => {
    let previous = 0;
    for (let consumed = 0; consumed <= 120; consumed += 0.5) {
      const step = degradationStepOf(consumed, 100, pcts);
      expect(step).toBeGreaterThanOrEqual(previous);
      previous = step;
    }
  });

  it('thresholds are read as a set: order and duplicates in the stored array do not matter', () => {
    expect(degradationStepOf(80, 100, [90, 50, 75, 50])).toBe(2);
  });

  it('a zero limit has crossed every threshold', () => {
    expect(degradationStepOf(0, 0, pcts)).toBe(3);
  });

  it('no soft thresholds means no degradation steps', () => {
    expect(degradationStepOf(99, 100, [])).toBe(0);
  });
});

describe('entryForStep — the declared order applies in order', () => {
  it('step n applies entry n of the declared order', () => {
    expect(DEGRADATION_ORDER).toEqual(['cheaper_tier', 'reduced_context', 'diagnosis_only']);
    expect(entryForStep(DEGRADATION_ORDER, 1, 3)).toBe('cheaper_tier');
    expect(entryForStep(DEGRADATION_ORDER, 2, 3)).toBe('reduced_context');
    expect(entryForStep(DEGRADATION_ORDER, 3, 3)).toBe('diagnosis_only');
  });

  it('more thresholds than entries stay on the last entry — never past the declared list', () => {
    expect(entryForStep(DEGRADATION_ORDER, 4, 5)).toBe('diagnosis_only');
  });

  it('the step one past the last threshold is exhaustion, not a declared entry', () => {
    expect(entryForStep(DEGRADATION_ORDER, 4, 3)).toBe(EXHAUSTED_ENTRY);
  });

  it('refuses step 0 — nothing is applied before the first threshold', () => {
    expect(() => entryForStep(DEGRADATION_ORDER, 0, 3)).toThrow();
  });
});

describe('stepsToMark', () => {
  it('every step from 1 to the current one, in order — a jump over a step still records it', () => {
    expect(stepsToMark({ crossed: 3, exhausted: false, thresholdCount: 3 })).toEqual([1, 2, 3]);
    expect(stepsToMark({ crossed: 0, exhausted: false, thresholdCount: 3 })).toEqual([]);
  });

  it('exhaustion is the step after the last threshold', () => {
    expect(stepsToMark({ crossed: 3, exhausted: true, thresholdCount: 3 })).toEqual([1, 2, 3, 4]);
  });
});
