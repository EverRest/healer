import { describe, expect, it } from 'vitest';
import { computeConflictWarnings, couldBothMatch } from './conflict-warnings.js';
import type { Rule } from './rule.js';

function rule(overrides: Partial<Rule>): Rule {
  return {
    ruleKey: 'r',
    predicates: [],
    outcome: 'allow',
    reasonCode: 'NO_ADOPTED_EXPECTATION',
    ...overrides,
  };
}

describe('couldBothMatch — pairwise predicate overlap', () => {
  it('two rules on unrelated fields can always both match', () => {
    const a = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'equals',
        value: 'prod',
      } as const,
    ];
    const b = [{ kind: 'boolean', field: 'evidence.complete', operator: 'isTrue' } as const];
    expect(couldBothMatch(a, b)).toBe(true);
  });

  it('equals vs equals on the same enumerated field with different values cannot both match', () => {
    const a = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'equals',
        value: 'prod',
      } as const,
    ];
    const b = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'equals',
        value: 'staging',
      } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(false);
  });

  it('equals vs equals on the same value can both match', () => {
    const a = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'equals',
        value: 'prod',
      } as const,
    ];
    const b = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'equals',
        value: 'prod',
      } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(true);
  });

  it('equals vs notEquals excluding the same value cannot both match', () => {
    const a = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'equals',
        value: 'prod',
      } as const,
    ];
    const b = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'notEquals',
        value: 'prod',
      } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(false);
  });

  it('two exclusion-only predicates on the same field cannot be proven disjoint (documented gap)', () => {
    const a = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'notEquals',
        value: 'prod',
      } as const,
    ];
    const b = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'notEquals',
        value: 'staging',
      } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(true);
  });

  it('isTrue vs isFalse on the same boolean field cannot both match', () => {
    const a = [{ kind: 'boolean', field: 'evidence.complete', operator: 'isTrue' } as const];
    const b = [{ kind: 'boolean', field: 'evidence.complete', operator: 'isFalse' } as const];
    expect(couldBothMatch(a, b)).toBe(false);
  });

  it('disjoint ordinal ranges cannot both match', () => {
    const a = [{ kind: 'ordinal', field: 'autonomy.level', operator: 'atMost', value: 1 } as const];
    const b = [
      { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 3 } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(false);
  });

  it('overlapping ordinal ranges can both match', () => {
    const a = [{ kind: 'ordinal', field: 'autonomy.level', operator: 'atMost', value: 3 } as const];
    const b = [
      { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 2 } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(true);
  });

  it('notIn is treated as an exclusion, same as notEquals', () => {
    const a = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'equals',
        value: 'prod',
      } as const,
    ];
    const b = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'notIn',
        value: ['prod', 'staging'],
      } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(false);
  });

  it('two positive predicates on the same field within one rule intersect rather than replace', () => {
    // rule A allows { prod, staging } via `in`, then narrows to `prod` via `equals` — the
    // intersection is just `prod`, not `staging`.
    const a = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'in',
        value: ['prod', 'staging'],
      } as const,
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'equals',
        value: 'prod',
      } as const,
    ];
    const b = [
      {
        kind: 'enumerated',
        field: 'target.environment',
        operator: 'equals',
        value: 'staging',
      } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(false);
  });

  it('ordinal equals combined with an overlapping range can both match', () => {
    const a = [{ kind: 'ordinal', field: 'autonomy.level', operator: 'equals', value: 2 } as const];
    const b = [
      { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 1 } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(true);
  });

  it("ordinal equals outside the other side's range cannot both match", () => {
    const a = [{ kind: 'ordinal', field: 'autonomy.level', operator: 'equals', value: 2 } as const];
    const b = [
      { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 3 } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(false);
  });

  it('quantity fields are never used to prove disjointness (documented gap)', () => {
    const a = [
      {
        kind: 'quantity',
        field: 'budget.consumed',
        operator: 'atMost',
        value: { kind: 'literal', value: 50 },
      } as const,
    ];
    const b = [
      {
        kind: 'quantity',
        field: 'budget.consumed',
        operator: 'atLeast',
        value: { kind: 'literal', value: 100 },
      } as const,
    ];
    expect(couldBothMatch(a, b)).toBe(true);
  });
});

describe('computeConflictWarnings (T020, FR-006, quickstart 6)', () => {
  it('one rule allows, another denies, both can match the same input → the pair is a warning', () => {
    const allow = rule({
      ruleKey: 'allow-code-change',
      predicates: [
        {
          kind: 'enumerated',
          field: 'action.actionClass',
          operator: 'equals',
          value: 'code_change',
        },
      ],
      outcome: 'allow',
    });
    const deny = rule({
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
    });
    expect(computeConflictWarnings([allow, deny])).toEqual([
      { ruleKeyA: 'allow-code-change', ruleKeyB: 'deny-code-change' },
    ]);
  });

  it('rules with the same outcome are never a conflict, however they overlap', () => {
    const a = rule({ ruleKey: 'a', outcome: 'allow', predicates: [] });
    const b = rule({ ruleKey: 'b', outcome: 'allow', predicates: [] });
    expect(computeConflictWarnings([a, b])).toEqual([]);
  });

  it('rules provably disjoint on a shared field are not a warning even with different outcomes', () => {
    const allowProd = rule({
      ruleKey: 'allow-prod',
      outcome: 'allow',
      predicates: [
        { kind: 'enumerated', field: 'target.environment', operator: 'equals', value: 'prod' },
      ],
    });
    const denyStaging = rule({
      ruleKey: 'deny-staging',
      outcome: 'deny',
      predicates: [
        { kind: 'enumerated', field: 'target.environment', operator: 'equals', value: 'staging' },
      ],
    });
    expect(computeConflictWarnings([allowProd, denyStaging])).toEqual([]);
  });

  it('order of the rule array does not change which pairs are reported', () => {
    const allow = rule({ ruleKey: 'allow', outcome: 'allow', predicates: [] });
    const deny = rule({ ruleKey: 'deny', outcome: 'deny', predicates: [] });
    const forward = computeConflictWarnings([allow, deny]);
    const reversed = computeConflictWarnings([deny, allow]);
    const normalize = (ws: readonly { ruleKeyA: string; ruleKeyB: string }[]) =>
      ws.map((w) => [w.ruleKeyA, w.ruleKeyB].sort().join(',')).sort();
    expect(normalize(forward)).toEqual(normalize(reversed));
  });
});
