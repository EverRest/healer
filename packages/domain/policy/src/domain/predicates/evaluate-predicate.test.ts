import { describe, expect, it } from 'vitest';
import { buildDecisionInput } from '../test-support/fixtures.js';
import { matchesConjunction, matchesPredicate } from './evaluate-predicate.js';
import type { Predicate } from './types.js';

// T010: the closed predicate vocabulary, exactly the operator-domain table of
// contracts/evaluation.md. One case per (field kind, operator) pair.

describe('matchesPredicate — enumerated', () => {
  const input = buildDecisionInput({ target: { ...buildDecisionInput().target, environment: 'production' } });

  it('equals / notEquals', () => {
    const equals: Predicate = { kind: 'enumerated', field: 'target.environment', operator: 'equals', value: 'production' };
    const notEquals: Predicate = { kind: 'enumerated', field: 'target.environment', operator: 'notEquals', value: 'staging' };
    expect(matchesPredicate(equals, input)).toBe(true);
    expect(matchesPredicate(notEquals, input)).toBe(true);
  });

  it('in / notIn', () => {
    const inSet: Predicate = { kind: 'enumerated', field: 'target.environment', operator: 'in', value: ['production', 'staging'] };
    const notIn: Predicate = { kind: 'enumerated', field: 'target.environment', operator: 'notIn', value: ['staging'] };
    expect(matchesPredicate(inSet, input)).toBe(true);
    expect(matchesPredicate(notIn, input)).toBe(true);
  });
});

describe('matchesPredicate — identifier', () => {
  const input = buildDecisionInput();

  it('equals / in / notIn — no hierarchy operator exists on the type (C-16)', () => {
    expect(matchesPredicate({ kind: 'identifier', field: 'target.componentId', operator: 'equals', value: 'component-1' }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'identifier', field: 'target.componentId', operator: 'in', value: ['component-1'] }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'identifier', field: 'target.componentId', operator: 'notIn', value: ['other'] }, input)).toBe(true);
  });
});

describe('matchesPredicate — boolean', () => {
  const input = buildDecisionInput();

  it('isTrue / isFalse — no implicit truthiness', () => {
    expect(matchesPredicate({ kind: 'boolean', field: 'evidence.complete', operator: 'isTrue' }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'boolean', field: 'reversibility.reversible', operator: 'isFalse' }, input)).toBe(false);
  });
});

describe('matchesPredicate — ordinal', () => {
  const input = buildDecisionInput({ autonomy: { level: 2 } });

  it('atLeast / atMost / equals', () => {
    expect(matchesPredicate({ kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 2 }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 3 }, input)).toBe(false);
    expect(matchesPredicate({ kind: 'ordinal', field: 'autonomy.level', operator: 'atMost', value: 2 }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'ordinal', field: 'autonomy.level', operator: 'equals', value: 2 }, input)).toBe(true);
  });
});

describe('matchesPredicate — quantity', () => {
  const input = buildDecisionInput({ budget: { consumed: 50, limit: 100, declaredMaxCost: 10, degradationStep: 0 } });

  it('atLeast / atMost against a literal', () => {
    expect(matchesPredicate({ kind: 'quantity', field: 'budget.consumed', operator: 'atLeast', value: { kind: 'literal', value: 50 } }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'quantity', field: 'budget.consumed', operator: 'atMost', value: { kind: 'literal', value: 49 } }, input)).toBe(false);
  });

  it('atLeast / atMost against another field in the same group', () => {
    // consumed + declaredMaxCost (60) <= limit (100)
    const predicate: Predicate = {
      kind: 'quantity',
      field: 'budget.limit',
      operator: 'atLeast',
      value: { kind: 'field', field: 'budget.consumed' },
    };
    expect(matchesPredicate(predicate, input)).toBe(true);
  });
});

describe('matchesPredicate — instant', () => {
  const input = buildDecisionInput({ evaluatedAt: new Date('2026-06-01T00:00:00.000Z') });

  it('before / after against a literal only', () => {
    expect(matchesPredicate({ kind: 'instant', field: 'evaluatedAt', operator: 'after', value: '2026-01-01T00:00:00.000Z' }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'instant', field: 'evaluatedAt', operator: 'before', value: '2026-01-01T00:00:00.000Z' }, input)).toBe(false);
  });
});

describe('matchesPredicate — closure (antitone only)', () => {
  const input = buildDecisionInput({
    impact: {
      ...buildDecisionInput().impact,
      closure: { memberIds: ['a', 'b'], maxDepth: 2 },
    },
  });

  it('containsNoneOf', () => {
    expect(matchesPredicate({ kind: 'closure', field: 'impact.closure', operator: 'containsNoneOf', value: ['c', 'd'] }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'closure', field: 'impact.closure', operator: 'containsNoneOf', value: ['a'] }, input)).toBe(false);
  });

  it('subsetOf', () => {
    expect(matchesPredicate({ kind: 'closure', field: 'impact.closure', operator: 'subsetOf', value: ['a', 'b', 'c'] }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'closure', field: 'impact.closure', operator: 'subsetOf', value: ['a'] }, input)).toBe(false);
  });

  it('sizeAtMost', () => {
    expect(matchesPredicate({ kind: 'closure', field: 'impact.closure', operator: 'sizeAtMost', value: 2 }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'closure', field: 'impact.closure', operator: 'sizeAtMost', value: 1 }, input)).toBe(false);
  });

  it('maxDepthAtMost', () => {
    expect(matchesPredicate({ kind: 'closure', field: 'impact.closure', operator: 'maxDepthAtMost', value: 2 }, input)).toBe(true);
    expect(matchesPredicate({ kind: 'closure', field: 'impact.closure', operator: 'maxDepthAtMost', value: 1 }, input)).toBe(false);
  });
});

describe('matchesConjunction', () => {
  const input = buildDecisionInput({ autonomy: { level: 2 } });

  it('requires every predicate to hold', () => {
    const conjunction: Predicate[] = [
      { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 2 },
      { kind: 'boolean', field: 'evidence.complete', operator: 'isTrue' },
    ];
    expect(matchesConjunction(conjunction, input)).toBe(true);
  });

  it('fails if any predicate fails', () => {
    const conjunction: Predicate[] = [
      { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 3 },
      { kind: 'boolean', field: 'evidence.complete', operator: 'isTrue' },
    ];
    expect(matchesConjunction(conjunction, input)).toBe(false);
  });

  it('the empty conjunction holds vacuously (a rule with no predicates matches every input)', () => {
    expect(matchesConjunction([], input)).toBe(true);
  });
});
