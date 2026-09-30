import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate.js';
import type { ResolvedRuleset, Rule } from './rule.js';
import { buildDecisionInput } from './test-support/fixtures.js';

// T013: property test — determinism and monotone restriction (quickstart scenario 1, FR-002,
// SC-002). No fast-check dependency in this repo — plain Vitest loops per the brief.

const allowRule: Rule = {
  ruleKey: 'allow-code-change',
  predicates: [
    { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
  ],
  outcome: 'allow',
  reasonCode: 'NO_ADOPTED_EXPECTATION',
};

function rulesetOf(rules: Rule[], overrides: Partial<ResolvedRuleset> = {}): ResolvedRuleset {
  return { version: 1, rules, ...overrides };
}

describe('evaluate — determinism (quickstart 1)', () => {
  it('evaluating the same input 1 000 times yields exactly one distinct outcome and matched-rule set', () => {
    const input = buildDecisionInput();
    const ruleset = rulesetOf([allowRule]);
    const outcomes = new Set<string>();
    const matchedSets = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const { decision } = evaluate(ruleset, input);
      outcomes.add(decision.outcome);
      matchedSets.add([...decision.matchedRuleKeys].sort().join(','));
    }
    expect(outcomes.size).toBe(1);
    expect(matchedSets.size).toBe(1);
  });

  it('is deterministic across a small corpus of varied inputs', () => {
    const ruleset = rulesetOf([allowRule]);
    const corpus = [
      buildDecisionInput(),
      buildDecisionInput({ action: { actionKey: 'x', actionClass: 'read_only' } }),
      buildDecisionInput({ autonomy: { level: 0 } }),
      buildDecisionInput({
        budget: { consumed: 100, limit: 100, declaredMaxCost: 1, degradationStep: 3 },
      }),
    ];
    for (const input of corpus) {
      const results = Array.from({ length: 200 }, () => evaluate(ruleset, input).decision.outcome);
      expect(new Set(results).size).toBe(1);
    }
  });
});

describe('evaluate — default deny (quickstart 4)', () => {
  it('no matching rule → DENY with reason NO_MATCHING_RULE', () => {
    const { decision } = evaluate(rulesetOf([]), buildDecisionInput());
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain('NO_MATCHING_RULE');
    expect(decision.matchedRuleKeys).toEqual([]);
  });
});

describe('evaluate — conflict resolves down (quickstart 6)', () => {
  it('one rule allows, another denies, both match → DENY', () => {
    const denyRule: Rule = {
      ruleKey: 'deny-code-change',
      predicates: [
        {
          kind: 'enumerated',
          field: 'action.actionClass',
          operator: 'equals',
          value: 'code_change',
        },
      ],
      outcome: 'deny',
      reasonCode: 'TARGET_BLOCKED',
    };
    const { decision } = evaluate(rulesetOf([allowRule, denyRule]), buildDecisionInput());
    expect(decision.outcome).toBe('deny');
    expect([...decision.matchedRuleKeys].sort()).toEqual(['allow-code-change', 'deny-code-change']);
  });
});

describe('evaluate — monotone restriction: steps 3-6 never turn DENY back into ALLOW', () => {
  it('ceiling clamp downgrades an over-ceiling ALLOW to DENY(CEILING_EXCEEDED)', () => {
    // read_only ceiling is L1; a rule allows on autonomy.level atLeast 5, granted level is 5 —
    // structurally over ceiling even though the rule itself matched and said ALLOW.
    const overCeilingAllow: Rule = {
      ruleKey: 'allow-over-ceiling',
      predicates: [{ kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 5 }],
      outcome: 'allow',
      reasonCode: 'NO_ADOPTED_EXPECTATION',
    };
    const input = buildDecisionInput({
      action: { actionKey: 'read.something', actionClass: 'read_only' },
      autonomy: { level: 5 },
    });
    const { decision } = evaluate(rulesetOf([overCeilingAllow]), input);
    expect(decision.outcome).toBe('deny');
    expect(decision.ceilingApplied).toBe(true);
    expect(decision.reasonCodes).toContain('CEILING_EXCEEDED');
  });

  it('ceilingApplied is false when the grant is within the ceiling', () => {
    const input = buildDecisionInput({
      action: { actionKey: 'read.something', actionClass: 'read_only' },
      autonomy: { level: 1 },
    });
    const withinCeiling: Rule = {
      ruleKey: 'allow-within-ceiling',
      predicates: [{ kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 1 }],
      outcome: 'allow',
      reasonCode: 'NO_ADOPTED_EXPECTATION',
    };
    const { decision } = evaluate(rulesetOf([withinCeiling]), input);
    expect(decision.outcome).toBe('allow');
    expect(decision.ceilingApplied).toBe(false);
  });

  it('reversible_remediation with an unattested undo has no level — an ALLOW is still clamped to DENY (quickstart 39)', () => {
    const input = buildDecisionInput({
      action: { actionKey: 'deployment.rollback', actionClass: 'reversible_remediation' },
      reversibility: { reversible: true, hasTestedUndo: false },
      autonomy: { level: 5 },
    });
    const { decision } = evaluate(rulesetOf([allowAnything()]), input);
    expect(decision.outcome).toBe('deny');
    expect(decision.ceilingApplied).toBe(true);
    expect(decision.reasonCodes).toContain('CEILING_EXCEEDED');
  });

  it('a ceilingless class (unattested reversible_remediation) with the realistic default autonomy.level: 0 is still denied — the ceiling bars unconditionally, not by comparing against the raw level', () => {
    // Regression: mapping ceiling.kind === 'none' to the number 0 made `min(rawLevel, 0)` a
    // no-op whenever rawLevel was *also* 0 (the ordinary "no grant yet" default, not a
    // hand-written excessive grant), so an ordinary rule that never mentions autonomy.level at
    // all (C-17 says a rule *may* reference it, never that it must) passed straight through.
    const input = buildDecisionInput({
      action: { actionKey: 'deployment.rollback', actionClass: 'reversible_remediation' },
      reversibility: { reversible: true, hasTestedUndo: false },
      autonomy: { level: 0 },
    });
    const { decision } = evaluate(rulesetOf([allowAnything()]), input);
    expect(decision.outcome).toBe('deny');
    expect(decision.ceilingApplied).toBe(true);
    expect(decision.reasonCodes).toContain('CEILING_EXCEEDED');
  });

  it('an unconditionally ceilingless class (merge) with autonomy.level: 0 is denied by a rule that never references autonomy.level (quickstart 8)', () => {
    const input = buildDecisionInput({
      action: { actionKey: 'change.merge_pull_request', actionClass: 'merge' },
      autonomy: { level: 0 },
    });
    const { decision } = evaluate(rulesetOf([allowAnything()]), input);
    expect(decision.outcome).toBe('deny');
    expect(decision.ceilingApplied).toBe(true);
    expect(decision.reasonCodes).toContain('CEILING_EXCEEDED');
  });

  it('rollback with a tested undo at L5 is permitted (quickstart 10)', () => {
    const input = buildDecisionInput({
      action: { actionKey: 'deployment.rollback', actionClass: 'reversible_remediation' },
      reversibility: { reversible: true, hasTestedUndo: true },
      autonomy: { level: 5 },
    });
    const rule: Rule = {
      ruleKey: 'allow-rollback',
      predicates: [{ kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 5 }],
      outcome: 'allow',
      reasonCode: 'NO_ADOPTED_EXPECTATION',
    };
    const { decision } = evaluate(rulesetOf([rule]), input);
    expect(decision.outcome).toBe('allow');
    expect(decision.ceilingApplied).toBe(false);
  });

  it('budget exhausted downgrades ALLOW to DENY(BUDGET_EXHAUSTED)', () => {
    const input = buildDecisionInput({
      budget: { consumed: 100, limit: 100, declaredMaxCost: 1, degradationStep: 0 },
    });
    const { decision } = evaluate(rulesetOf([allowRule]), input);
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain('BUDGET_EXHAUSTED');
  });

  it('budget degraded (below limit) does not deny by itself', () => {
    const input = buildDecisionInput({
      budget: { consumed: 80, limit: 100, declaredMaxCost: 1, degradationStep: 2 },
    });
    const { decision } = evaluate(rulesetOf([allowRule]), input);
    expect(decision.outcome).toBe('allow');
    expect(decision.reasonCodes).not.toContain('BUDGET_EXHAUSTED');
  });

  it('cooldown: attempt cap reached downgrades ALLOW to DENY(ATTEMPT_CAP_REACHED)', () => {
    const input = buildDecisionInput({
      cooldown: { recentAllowCount: 0, windowSeconds: 60, attemptCount: 5 },
    });
    const ruleset = rulesetOf([allowRule], {
      cooldownBounds: { ratePerWindow: 100, cooldownSeconds: 0, attemptCap: 5 },
    });
    const { decision } = evaluate(ruleset, input);
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
  });

  it('cooldown: rate limited downgrades ALLOW to DENY(RATE_LIMITED)', () => {
    const input = buildDecisionInput({
      cooldown: { recentAllowCount: 10, windowSeconds: 60, attemptCount: 0 },
    });
    const ruleset = rulesetOf([allowRule], {
      cooldownBounds: { ratePerWindow: 10, cooldownSeconds: 0, attemptCap: 999 },
    });
    const { decision } = evaluate(ruleset, input);
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain('RATE_LIMITED');
  });

  it('cooldown: not enough time since the last allow downgrades ALLOW to DENY(COOLDOWN)', () => {
    const input = buildDecisionInput({
      cooldown: { recentAllowCount: 1, windowSeconds: 5, attemptCount: 0 },
    });
    const ruleset = rulesetOf([allowRule], {
      cooldownBounds: { ratePerWindow: 999, cooldownSeconds: 30, attemptCap: 999 },
    });
    const { decision } = evaluate(ruleset, input);
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain('COOLDOWN');
  });

  it('cooldown step is a no-op when the ruleset has no configured bounds', () => {
    const input = buildDecisionInput({
      cooldown: { recentAllowCount: 999, windowSeconds: 0, attemptCount: 999 },
    });
    const { decision } = evaluate(rulesetOf([allowRule]), input);
    expect(decision.outcome).toBe('allow');
  });

  it('a DENY from an earlier step is never turned back into ALLOW by a later step', () => {
    // No matching rule (step 3 → DENY), but budget and cooldown are both perfectly healthy —
    // steps 5 and 6 must leave the DENY alone rather than "fixing" it.
    const input = buildDecisionInput({
      budget: { consumed: 0, limit: 100, declaredMaxCost: 1, degradationStep: 0 },
      cooldown: { recentAllowCount: 0, windowSeconds: 60, attemptCount: 0 },
    });
    const { decision } = evaluate(rulesetOf([]), input);
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain('NO_MATCHING_RULE');
  });
});

describe('evaluate — trace', () => {
  it('carries matched rules, fold result, ceiling flag, autonomy level, budget state and reason codes', () => {
    const input = buildDecisionInput({ autonomy: { level: 2 } });
    const { trace } = evaluate(rulesetOf([allowRule]), input);
    expect(trace.matchedRules).toEqual([{ ruleKey: 'allow-code-change', outcome: 'allow' }]);
    expect(trace.foldResult).toBe('allow');
    expect(trace.ceilingApplied).toBe(false);
    expect(trace.resolvedAutonomyLevel).toBe(2);
    expect(trace.budgetState).toEqual({
      consumed: 0,
      limit: 100,
      declaredMaxCost: 1,
      degradationStep: 0,
    });
    expect(trace.reasonCodes).toEqual(['NO_ADOPTED_EXPECTATION']);
  });
});

function allowAnything(): Rule {
  return {
    ruleKey: 'allow-anything',
    predicates: [],
    outcome: 'allow',
    reasonCode: 'NO_ADOPTED_EXPECTATION',
  };
}
