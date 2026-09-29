import { describe, expect, it } from 'vitest';
import { buildDecisionInput } from '../test-support/fixtures.js';
import {
  readBooleanField,
  readClosureField,
  readEnumeratedField,
  readIdentifierField,
  readInstantField,
  readOrdinalField,
  readQuantityField,
} from './field-access.js';
import { BOOLEAN_FIELDS, ENUMERATED_FIELDS, IDENTIFIER_FIELDS, INSTANT_FIELDS, ORDINAL_FIELDS, QUANTITY_FIELDS } from './fields.js';

// Exhaustive per-field coverage: every field in the closed vocabulary (fields.ts) resolves
// against a real DecisionInput without throwing — one case per field, not only per field-kind
// (evaluate-predicate.test.ts already covers one representative field per kind and operator).

describe('field-access — every enumerated field resolves', () => {
  const input = buildDecisionInput();
  it.each(ENUMERATED_FIELDS)('%s', (field) => {
    expect(typeof readEnumeratedField(field, input)).toBe('string');
  });
});

describe('field-access — every identifier field resolves', () => {
  const input = buildDecisionInput();
  it.each(IDENTIFIER_FIELDS)('%s', (field) => {
    expect(typeof readIdentifierField(field, input)).toBe('string');
  });
});

describe('field-access — every boolean field resolves', () => {
  const input = buildDecisionInput();
  it.each(BOOLEAN_FIELDS)('%s', (field) => {
    expect(typeof readBooleanField(field, input)).toBe('boolean');
  });
});

describe('field-access — every ordinal field resolves', () => {
  const input = buildDecisionInput();
  it.each(ORDINAL_FIELDS)('%s', (field) => {
    expect(typeof readOrdinalField(field, input)).toBe('number');
  });
});

describe('field-access — every quantity field resolves', () => {
  const input = buildDecisionInput();
  it.each(QUANTITY_FIELDS)('%s', (field) => {
    expect(typeof readQuantityField(field, input)).toBe('number');
  });
});

describe('field-access — every instant field resolves', () => {
  const input = buildDecisionInput();
  it.each(INSTANT_FIELDS)('%s', (field) => {
    expect(readInstantField(field, input)).toBeInstanceOf(Date);
  });
});

describe('field-access — the closure field resolves', () => {
  const input = buildDecisionInput();
  it('impact.closure', () => {
    expect(readClosureField('impact.closure', input)).toEqual(input.impact.closure);
  });
});
