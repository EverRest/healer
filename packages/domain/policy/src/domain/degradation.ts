// The degradation vocabulary and the pure functions over it (T063, T064; FR-012, R-12).
//
// **`DEGRADATION_ORDER` is the one authority** for the closed list of degradation entries and the
// order they apply in (spec US4: cheaper tier, reduced context, diagnosis-only). 012's
// `tenant_budget.degradation_order` may reorder or shorten it per tenant, but may only name
// members of this list — a tenant cannot invent an entry the product has no handling for.

export const DEGRADATION_ORDER = ['cheaper_tier', 'reduced_context', 'diagnosis_only'] as const;
export type DegradationEntry = (typeof DEGRADATION_ORDER)[number];

/** The step one past the last soft threshold: the limit is reached and AI steps are refused. It is
 *  recorded like any other step, so "the budget ran out" is evidence too. */
export const EXHAUSTED_ENTRY = 'ai_steps_refused';

/** The count of soft thresholds crossed by `consumed / limit` (R-12). Monotone in `consumed`, so
 *  within a period the step can only advance. A zero limit has crossed everything. */
export function degradationStepOf(
  consumed: number,
  limit: number,
  softThresholdPcts: readonly number[],
): number {
  const distinct = new Set(softThresholdPcts);
  if (limit <= 0) return distinct.size;
  const pct = (consumed / limit) * 100;
  let crossed = 0;
  for (const threshold of distinct) if (pct >= threshold) crossed += 1;
  return crossed;
}

/** The entry applied when a scope first advances to `step` (1-based). Step `thresholdCount + 1` is
 *  exhaustion. With more thresholds than entries the last entry persists — never past the list. */
export function entryForStep(
  order: readonly string[],
  step: number,
  thresholdCount: number,
): string {
  if (step < 1) throw new Error('degradation step 0 applies no entry');
  if (step > thresholdCount) return EXHAUSTED_ENTRY;
  const entry = order[Math.min(step, order.length) - 1];
  if (entry === undefined) throw new Error('degradation order is empty');
  return entry;
}

/** Every step from 1 to the last threshold crossed — a jump over a step still records it, so "in
 *  order, one evidence record per step" holds however large a single charge is — and, when the
 *  scope is exhausted, the exhaustion step. A refusal that arrives before any threshold was
 *  crossed records only exhaustion: steps nothing ever reached are not claimed. */
export function stepsToMark(state: {
  readonly crossed: number;
  readonly exhausted: boolean;
  readonly thresholdCount: number;
}): readonly number[] {
  const steps = Array.from({ length: state.crossed }, (_, i) => i + 1);
  return state.exhausted ? [...steps, state.thresholdCount + 1] : steps;
}
