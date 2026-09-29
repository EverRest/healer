import { describe, expect, it } from 'vitest';
import { foldOutcomes, type Outcome } from './outcome-lattice.js';

// T009: property test over the lattice (no fast-check dependency in this repo — a new
// property-testing library needs an ADR first; plain Vitest loops/permutations per the brief).
// Quickstart scenarios 1 (determinism) and 4 (empty multiset → DENY).

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([items[i] as T, ...perm]);
    }
  }
  return result;
}

describe('foldOutcomes', () => {
  it('yields DENY for the empty multiset (default-deny, FR-005)', () => {
    expect(foldOutcomes([])).toBe('deny');
  });

  it('is order-independent over every permutation of a matched multiset (FR-002, R-04)', () => {
    const multiset: Outcome[] = ['allow', 'require_approval', 'allow', 'deny', 'require_approval'];
    const results = permutations(multiset).map((perm) => foldOutcomes(perm));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('deny');
  });

  it('is order-independent for an all-ALLOW multiset — folds to ALLOW, not DENY', () => {
    const multiset: Outcome[] = ['allow', 'allow', 'allow'];
    const results = permutations(multiset).map((perm) => foldOutcomes(perm));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('allow');
  });

  it('resolves ALLOW vs REQUIRE_APPROVAL to the more restrictive REQUIRE_APPROVAL', () => {
    expect(foldOutcomes(['allow', 'require_approval'])).toBe('require_approval');
    expect(foldOutcomes(['require_approval', 'allow'])).toBe('require_approval');
  });

  it('a single-element multiset folds to that element', () => {
    expect(foldOutcomes(['allow'])).toBe('allow');
    expect(foldOutcomes(['require_approval'])).toBe('require_approval');
    expect(foldOutcomes(['deny'])).toBe('deny');
  });

  it('is order-independent across many random shuffles of a larger multiset', () => {
    const multiset: Outcome[] = [
      'allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow',
      'require_approval',
    ];
    const first = foldOutcomes(multiset);
    for (let seed = 0; seed < 200; seed += 1) {
      const shuffled = seededShuffle(multiset, seed);
      expect(foldOutcomes(shuffled)).toBe(first);
    }
    expect(first).toBe('require_approval');
  });
});

/** Deterministic shuffle (no crypto randomness needed — reproducible across CI runs). */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const arr = items.slice();
  let state = seed + 1;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    const ai = arr[i] as T;
    const aj = arr[j] as T;
    arr[i] = aj;
    arr[j] = ai;
  }
  return arr;
}
