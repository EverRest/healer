import { describe, expect, it } from 'vitest';
import type { Predicate } from './types.js';
import { fieldKindOf, OPERATORS_BY_KIND, validatePredicateShape } from './validate.js';

describe('validatePredicateShape (batch 9 I2, review finding)', () => {
  it('accepts a well-formed predicate of every kind', () => {
    const predicates: Predicate[] = [
      { kind: 'enumerated', field: 'target.environment', operator: 'equals', value: 'production' },
      { kind: 'identifier', field: 'target.targetRef', operator: 'equals', value: 'target-1' },
      { kind: 'boolean', field: 'evidence.complete', operator: 'isTrue' },
      { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 2 },
      {
        kind: 'quantity',
        field: 'budget.consumed',
        operator: 'atLeast',
        value: { kind: 'literal', value: 50 },
      },
      {
        kind: 'quantity',
        field: 'budget.consumed',
        operator: 'atMost',
        value: { kind: 'field', field: 'budget.limit' },
      },
      { kind: 'instant', field: 'evaluatedAt', operator: 'before', value: '2026-01-01T00:00:00.000Z' },
      { kind: 'closure', field: 'impact.closure', operator: 'sizeAtMost', value: 3 },
    ];
    for (const predicate of predicates) {
      expect(validatePredicateShape(predicate)).toBeNull();
    }
  });

  it('rejects an unknown field', () => {
    const predicate = { kind: 'enumerated', field: 'not.a.real.field', operator: 'equals', value: 'x' } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/unknown predicate field/);
  });

  it('rejects a predicate tagged with the wrong kind for its field', () => {
    const predicate = {
      kind: 'quantity',
      field: 'target.environment',
      operator: 'atLeast',
      value: { kind: 'literal', value: 1 },
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/is a "enumerated" field/);
  });

  it('rejects an operator outside its kind\'s domain', () => {
    const predicate = {
      kind: 'boolean',
      field: 'evidence.complete',
      operator: 'atLeast',
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/outside the domain/);
  });

  it('rejects a quantity comparison against a field in a different group', () => {
    const predicate: Predicate = {
      kind: 'quantity',
      field: 'budget.consumed',
      operator: 'atLeast',
      value: { kind: 'field', field: 'cooldown.attemptCount' },
    };
    expect(validatePredicateShape(predicate)).toMatch(/not in the same group/);
  });

  it('accepts a quantity comparison against a field in the same group', () => {
    const predicate: Predicate = {
      kind: 'quantity',
      field: 'cooldown.recentAllowCount',
      operator: 'atMost',
      value: { kind: 'field', field: 'cooldown.attemptCount' },
    };
    expect(validatePredicateShape(predicate)).toBeNull();
  });

  it('rejects an instant literal that does not parse as a date', () => {
    const predicate: Predicate = {
      kind: 'instant',
      field: 'evaluatedAt',
      operator: 'before',
      value: 'definitely-not-a-date',
    };
    expect(validatePredicateShape(predicate)).toMatch(/does not parse as a date/);
  });

  it('fieldKindOf and OPERATORS_BY_KIND agree on every field this module knows about', () => {
    expect(fieldKindOf('budget.consumed')).toBe('quantity');
    expect(OPERATORS_BY_KIND.quantity).toEqual(['atLeast', 'atMost']);
    expect(fieldKindOf('nonexistent.field')).toBeUndefined();
  });
});
