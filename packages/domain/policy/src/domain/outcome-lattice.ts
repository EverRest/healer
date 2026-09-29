// T008: the outcome lattice. `ALLOW < REQUIRE_APPROVAL < DENY`, and a `max` fold over a multiset
// of matched-rule outcomes (contracts/evaluation.md step 3, FR-005, FR-006, R-04). Tiny and
// total — no dependency on `decision-input.ts` or `evaluate.ts`.

export const OUTCOME_ORDER = ['allow', 'require_approval', 'deny'] as const;

export type Outcome = (typeof OUTCOME_ORDER)[number];

function rank(outcome: Outcome): number {
  return OUTCOME_ORDER.indexOf(outcome);
}

/** The more restrictive of two outcomes — the `max` operator of the lattice. */
export function maxOutcome(a: Outcome, b: Outcome): Outcome {
  return rank(b) > rank(a) ? b : a;
}

// "Seeded with DENY" (R-04) describes the identity the fold returns for the **empty** multiset —
// the mechanism that makes "no rule matched" and "matched rules disagree" one fold with one
// answer, not two separate mechanisms. It does not mean DENY is threaded into `max` as a running
// accumulator for a non-empty multiset: DENY is the top of this order, so `max(DENY, x) = DENY`
// for every `x`, and seeding a non-empty reduction with it would force every decision to DENY
// regardless of what matched — the opposite of FR-006 ("matching rules that disagree produce the
// most restrictive outcome" is a real `max` over what actually matched, not a foregone
// conclusion). So: empty multiset → the DENY seed; non-empty multiset → `max` over its own
// elements, no seed injected.
export function foldOutcomes(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.length === 0) return 'deny';
  return outcomes.reduce(maxOutcome);
}
