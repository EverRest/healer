import { describe, expect, it } from 'vitest';
import { computeRequestKey } from './request-key.js';
import { buildDecisionInput } from './test-support/fixtures.js';

// T060: the idempotency key of a charged step. A retry of the same step must map to the same key
// however the budget moved in between; a different step must not.
describe('computeRequestKey', () => {
  const base = buildDecisionInput();

  it('ignores everything the evaluation resolves and the instant it ran at', () => {
    const retried = buildDecisionInput({
      budget: {
        consumed: 77,
        limit: 5,
        declaredMaxCost: base.budget.declaredMaxCost,
        degradationStep: 2,
      },
      autonomy: { level: 0 },
      escalation: { attemptCount: 3 },
      cooldown: { recentAllowCount: 9, windowSeconds: 1, attemptCount: 9 },
      action: { actionKey: base.action.actionKey, actionClass: 'merge' },
      evaluatedAt: new Date('2031-01-01T00:00:00Z'),
    });
    expect(computeRequestKey(retried)).toBe(computeRequestKey(base));
  });

  it.each([
    [
      'the declared maximum',
      buildDecisionInput({ budget: { ...base.budget, declaredMaxCost: 99 } }),
    ],
    [
      'the action',
      buildDecisionInput({ action: { actionKey: 'other.action', actionClass: 'code_change' } }),
    ],
    ['the target', buildDecisionInput({ target: { ...base.target, targetRef: 'elsewhere' } })],
    [
      'whether it escalates',
      buildDecisionInput({ escalation: { attemptCount: 0, escalating: true } }),
    ],
    [
      'the evidence state',
      buildDecisionInput({ evidence: { complete: false, conclusionHasLink: true } }),
    ],
  ])('differs when %s differs', (_label, other) => {
    expect(computeRequestKey(other)).not.toBe(computeRequestKey(base));
  });

  it('is a stable hex digest', () => {
    expect(computeRequestKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
