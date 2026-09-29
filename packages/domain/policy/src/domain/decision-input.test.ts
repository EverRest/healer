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
    const withNestedConfidence = { ...input, eligibility: { ...input.eligibility, confidence: 0.99 } };
    const result = decisionInputSchema.safeParse(withNestedConfidence);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key generally, not only confidence', () => {
    const result = decisionInputSchema.safeParse({ ...buildDecisionInput(), extra: 'anything' });
    expect(result.success).toBe(false);
  });
});
