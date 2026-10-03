import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate.js';
import type { ResolvedRuleset, Rule } from './rule.js';
import { buildDecisionInput } from './test-support/fixtures.js';

// T059/T060 (R-11, SC-006): the ex-ante predicate `consumed + declaredMax <= limit`, not
// `consumed < limit` — a check on consumption alone always permits one more step than the budget
// allows, because the step that discovers the limit is the step that exceeds it.
// T066 (FR-013): the escalation attempt count is an INPUT; the cap rides the resolved rule set.

const allowRule: Rule = {
  ruleKey: 'allow-code-change',
  predicates: [
    { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
  ],
  outcome: 'allow',
  reasonCode: 'NO_ADOPTED_EXPECTATION',
};
const rulesetOf = (overrides: Partial<ResolvedRuleset> = {}): ResolvedRuleset => ({
  version: 1,
  rules: [allowRule],
  ...overrides,
});
const budget = (consumed: number, limit: number, declaredMaxCost: number) => ({
  consumed,
  limit,
  declaredMaxCost,
  degradationStep: 0,
});

describe('evaluate — ex-ante budget predicate (T059, T060)', () => {
  it('refuses a step whose declared maximum would cross the limit, though consumption is still below it', () => {
    const { decision } = evaluate(rulesetOf(), buildDecisionInput({ budget: budget(95, 100, 6) }));
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain('BUDGET_EXHAUSTED');
  });

  it('permits a step that lands exactly on the limit (consumed + declaredMax <= limit)', () => {
    const { decision } = evaluate(rulesetOf(), buildDecisionInput({ budget: budget(95, 100, 5) }));
    expect(decision.outcome).toBe('allow');
  });

  it('refuses at consumed = limit even when nothing more is declared (exhausted)', () => {
    const { decision } = evaluate(rulesetOf(), buildDecisionInput({ budget: budget(100, 100, 0) }));
    expect(decision.reasonCodes).toContain('BUDGET_EXHAUSTED');
  });

  it('a zero limit refuses everything', () => {
    const { decision } = evaluate(rulesetOf(), buildDecisionInput({ budget: budget(0, 0, 0) }));
    expect(decision.reasonCodes).toContain('BUDGET_EXHAUSTED');
  });
});

describe('evaluate — escalation attempt cap (T066)', () => {
  const cap = 2;

  // The cap bounds *escalation*, so it applies to an escalating proposal only: a tenant whose cap is
  // 0, or a run that has already escalated twice, must still be able to take every other action.
  const escalating = (attemptCount: number) => ({ attemptCount, escalating: true });

  it('denies an escalating proposal with its own reason once the attempt count reaches the cap', () => {
    const { decision } = evaluate(
      rulesetOf({ escalationAttemptCap: cap }),
      buildDecisionInput({ escalation: escalating(2) }),
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain('ESCALATION_CAP_REACHED');
    expect(decision.reasonCodes).not.toContain('ATTEMPT_CAP_REACHED');
  });

  it('allows an escalating proposal while the count is below the cap', () => {
    const { decision } = evaluate(
      rulesetOf({ escalationAttemptCap: cap }),
      buildDecisionInput({ escalation: escalating(1) }),
    );
    expect(decision.outcome).toBe('allow');
  });

  it('a cap of zero stops escalation before it starts', () => {
    const { decision } = evaluate(
      rulesetOf({ escalationAttemptCap: 0 }),
      buildDecisionInput({ escalation: escalating(0) }),
    );
    expect(decision.reasonCodes).toContain('ESCALATION_CAP_REACHED');
  });

  it('a non-escalating proposal is never refused by the cap, whatever the count and however low the cap', () => {
    for (const count of [0, 2, 99]) {
      const { decision } = evaluate(
        rulesetOf({ escalationAttemptCap: 0 }),
        buildDecisionInput({ escalation: { attemptCount: count } }),
      );
      expect(decision.outcome).toBe('allow');
    }
  });

  it('enforces nothing when the rule set carries no cap', () => {
    const { decision } = evaluate(rulesetOf(), buildDecisionInput({ escalation: escalating(99) }));
    expect(decision.outcome).toBe('allow');
  });
});
