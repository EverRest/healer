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

  // Batch 9 follow-up review (both independent Opus reviews, reproduced live): the "same group"
  // check alone let a quantity predicate compare against a field that merely shares its string
  // prefix but is a different kind entirely — `budget.degradationStep` is `ordinal`, not
  // `quantity` — which reached `evaluate()` unrejected and threw `unreachable field`.
  it('rejects a quantity comparison against a same-prefix field that is not itself a quantity field', () => {
    const predicate: Predicate = {
      kind: 'quantity',
      field: 'budget.consumed',
      operator: 'atMost',
      value: { kind: 'field', field: 'budget.degradationStep' as never },
    };
    expect(validatePredicateShape(predicate)).toMatch(/is not a quantity field/);
  });

  it('rejects a quantity value.field that is not a registered field at all', () => {
    const predicate: Predicate = {
      kind: 'quantity',
      field: 'budget.consumed',
      operator: 'atMost',
      value: { kind: 'field', field: 'budget.bogus' as never },
    };
    expect(validatePredicateShape(predicate)).toMatch(/is not a quantity field/);
  });

  it('rejects a quantity value with an unrecognized kind', () => {
    const predicate = {
      kind: 'quantity',
      field: 'budget.consumed',
      operator: 'atMost',
      value: { kind: 'computed', expression: '1 + 1' },
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/unrecognized kind/);
  });

  it('rejects a quantity value that is not an object at all', () => {
    const predicate = {
      kind: 'quantity',
      field: 'budget.consumed',
      operator: 'atMost',
      value: 5,
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/wrong type/);
  });

  it('rejects a quantity literal whose value is not a number', () => {
    const predicate = {
      kind: 'quantity',
      field: 'budget.consumed',
      operator: 'atMost',
      value: { kind: 'literal', value: 'fifty' },
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/wrong type/);
  });

  // Batch 9 follow-up review, round 3: the DTO's now-removed `VALUE_SCHEMA_BY_KIND_AND_OPERATOR`
  // used `.strict()` on `QuantityValue`, which this function did not enforce — an in-process
  // publish accepted an extra key over the same shape HTTP rejected. Removing the DTO's copy
  // means this is now the only place that check can live.
  it('rejects a quantity literal value carrying an extra key', () => {
    const predicate = {
      kind: 'quantity',
      field: 'budget.consumed',
      operator: 'atMost',
      value: { kind: 'literal', value: 50, extra: 'nope' },
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/wrong type/);
  });

  it('rejects a quantity field-reference value carrying an extra key', () => {
    const predicate = {
      kind: 'quantity',
      field: 'budget.consumed',
      operator: 'atMost',
      value: { kind: 'field', field: 'budget.limit', extra: 'nope' },
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/wrong type/);
  });

  it('rejects an ordinal predicate whose value is not a number', () => {
    const predicate = {
      kind: 'ordinal',
      field: 'autonomy.level',
      operator: 'atLeast',
      value: '2',
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/wrong type/);
  });

  it('rejects an instant predicate whose value is a number, not a string (would otherwise parse as epoch millis)', () => {
    const predicate = {
      kind: 'instant',
      field: 'evaluatedAt',
      operator: 'before',
      value: 1700000000000,
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/wrong type/);
  });

  it('rejects an enumerated "in" predicate whose value is a single string, not an array', () => {
    const predicate = {
      kind: 'enumerated',
      field: 'target.environment',
      operator: 'in',
      value: 'production',
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/wrong type/);
  });

  it('rejects a closure sizeAtMost predicate whose value is not a number', () => {
    const predicate = {
      kind: 'closure',
      field: 'impact.closure',
      operator: 'sizeAtMost',
      value: ['a', 'b'],
    } as unknown as Predicate;
    expect(validatePredicateShape(predicate)).toMatch(/wrong type/);
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
