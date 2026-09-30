import { describe, expect, it } from 'vitest';
import { decisionInputSchema } from './decision-input.js';
import { buildDecisionInput } from './test-support/fixtures.js';

// T007: confidence is not representable. A `DecisionInput` schema-validated with
// `additionalProperties: false` must reject an extra `confidence` key rather than silently
// dropping or ignoring it — FR-003, R-03, quickstart scenario 3.

describe('decisionInputSchema', () => {
  it('accepts a well-formed DecisionInput', () => {
    const result = decisionInputSchema.safeParse(buildDecisionInput());
    expect(result.success).toBe(true);
  });

  it('rejects a top-level confidence key — the field does not exist', () => {
    const withConfidence = { ...buildDecisionInput(), confidence: 0.99 };
    const result = decisionInputSchema.safeParse(withConfidence);
    expect(result.success).toBe(false);
  });

  it('rejects a confidence key nested inside a field group, not only at the top level', () => {
    const input = buildDecisionInput();
    const withNestedConfidence = {
      ...input,
      eligibility: { ...input.eligibility, confidence: 0.99 },
    };
    const result = decisionInputSchema.safeParse(withNestedConfidence);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key generally, not only confidence', () => {
    const result = decisionInputSchema.safeParse({ ...buildDecisionInput(), extra: 'anything' });
    expect(result.success).toBe(false);
  });

  // Batch 9 C2, review finding: `decision_input` round-trips through JSONB, which has no `Date`
  // type — `evaluatedAt` comes back a string, and a raw type cast used to leave it that way, so
  // `matchesInstant`'s `.getTime()` threw on any stored decision with an instant predicate.
  it('coerces a string evaluatedAt (the shape a JSONB round-trip hands back) into a real Date', () => {
    const jsonRoundTripped = { ...buildDecisionInput(), evaluatedAt: '2026-01-01T00:00:00.000Z' };
    const result = decisionInputSchema.safeParse(jsonRoundTripped);
    expect(result.success).toBe(true);
    expect(result.success && result.data.evaluatedAt).toBeInstanceOf(Date);
    expect(result.success && result.data.evaluatedAt.getTime()).toBe(
      new Date('2026-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('still rejects an evaluatedAt that does not parse as a date at all', () => {
    const result = decisionInputSchema.safeParse({
      ...buildDecisionInput(),
      evaluatedAt: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  // Batch 9 follow-up review (both independent Opus reviews): a bare `z.coerce.date()` calls
  // `new Date(x)` on *any* input, so `null` -> 1970-01-01 and a number/boolean silently become
  // dates too — a caller mistake `z.date()` used to reject outright before this schema coerced at
  // all. The fix restricts coercion to an actual `Date` or a proper ISO datetime string.
  it.each([null, true, 12345, {}, []])(
    'rejects a non-date, non-ISO-string evaluatedAt: %j',
    (bad) => {
      const result = decisionInputSchema.safeParse({ ...buildDecisionInput(), evaluatedAt: bad });
      expect(result.success).toBe(false);
    },
  );

  it('rejects a non-ISO date-like string that a bare `new Date(...)` would have silently accepted', () => {
    // `new Date('2026/01/01')` parses successfully (locale-dependent, non-ISO) — the old
    // `dry-run.dto.ts` preprocessing plus a bare `z.coerce.date()` would have accepted it.
    const result = decisionInputSchema.safeParse({
      ...buildDecisionInput(),
      evaluatedAt: '2026/01/01',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a real Date instance unchanged', () => {
    const date = new Date('2026-06-15T12:00:00.000Z');
    const result = decisionInputSchema.safeParse({ ...buildDecisionInput(), evaluatedAt: date });
    expect(result.success).toBe(true);
    expect(result.success && result.data.evaluatedAt.getTime()).toBe(date.getTime());
  });

  it('accepts an ISO datetime string with a non-Z numeric offset', () => {
    const result = decisionInputSchema.safeParse({
      ...buildDecisionInput(),
      evaluatedAt: '2026-01-01T00:00:00.000+02:00',
    });
    expect(result.success).toBe(true);
  });
});
