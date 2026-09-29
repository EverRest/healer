import type { DecisionInput } from '../decision-input.js';
import {
  readBooleanField,
  readClosureField,
  readEnumeratedField,
  readIdentifierField,
  readInstantField,
  readOrdinalField,
  readQuantityField,
} from './field-access.js';
import type { Predicate, PredicateConjunction, QuantityValue } from './types.js';

function resolveQuantityValue(value: QuantityValue, input: DecisionInput): number {
  return value.kind === 'literal' ? value.value : readQuantityField(value.field, input);
}

function matchesEnumerated(
  predicate: Extract<Predicate, { kind: 'enumerated' }>,
  input: DecisionInput,
): boolean {
  const actual = readEnumeratedField(predicate.field, input);
  switch (predicate.operator) {
    case 'equals':
      return actual === predicate.value;
    case 'notEquals':
      return actual !== predicate.value;
    case 'in':
      return predicate.value.includes(actual);
    case 'notIn':
      return !predicate.value.includes(actual);
  }
}

function matchesIdentifier(
  predicate: Extract<Predicate, { kind: 'identifier' }>,
  input: DecisionInput,
): boolean {
  const actual = readIdentifierField(predicate.field, input);
  switch (predicate.operator) {
    case 'equals':
      return actual === predicate.value;
    case 'in':
      return predicate.value.includes(actual);
    case 'notIn':
      return !predicate.value.includes(actual);
  }
}

function matchesBoolean(
  predicate: Extract<Predicate, { kind: 'boolean' }>,
  input: DecisionInput,
): boolean {
  const actual = readBooleanField(predicate.field, input);
  return predicate.operator === 'isTrue' ? actual : !actual;
}

function matchesOrdinal(
  predicate: Extract<Predicate, { kind: 'ordinal' }>,
  input: DecisionInput,
): boolean {
  const actual = readOrdinalField(predicate.field, input);
  switch (predicate.operator) {
    case 'atLeast':
      return actual >= predicate.value;
    case 'atMost':
      return actual <= predicate.value;
    case 'equals':
      return actual === predicate.value;
  }
}

function matchesQuantity(
  predicate: Extract<Predicate, { kind: 'quantity' }>,
  input: DecisionInput,
): boolean {
  const actual = readQuantityField(predicate.field, input);
  const target = resolveQuantityValue(predicate.value, input);
  return predicate.operator === 'atLeast' ? actual >= target : actual <= target;
}

function matchesInstant(
  predicate: Extract<Predicate, { kind: 'instant' }>,
  input: DecisionInput,
): boolean {
  const actual = readInstantField(predicate.field, input).getTime();
  const literal = new Date(predicate.value).getTime();
  return predicate.operator === 'before' ? actual < literal : actual > literal;
}

function matchesClosure(
  predicate: Extract<Predicate, { kind: 'closure' }>,
  input: DecisionInput,
): boolean {
  const closure = readClosureField(predicate.field, input);
  switch (predicate.operator) {
    case 'containsNoneOf':
      return !closure.memberIds.some((id) => predicate.value.includes(id));
    case 'subsetOf':
      return closure.memberIds.every((id) => predicate.value.includes(id));
    case 'sizeAtMost':
      return closure.memberIds.length <= predicate.value;
    case 'maxDepthAtMost':
      return closure.maxDepth <= predicate.value;
  }
}

/** `(predicate, input) → boolean`. Total: a well-typed predicate over a schema-valid
 *  `DecisionInput` never throws (T010) — a runtime type mismatch is what T006's schema should
 *  already have rejected, not something this layer re-checks. */
export function matchesPredicate(predicate: Predicate, input: DecisionInput): boolean {
  switch (predicate.kind) {
    case 'enumerated':
      return matchesEnumerated(predicate, input);
    case 'identifier':
      return matchesIdentifier(predicate, input);
    case 'boolean':
      return matchesBoolean(predicate, input);
    case 'ordinal':
      return matchesOrdinal(predicate, input);
    case 'quantity':
      return matchesQuantity(predicate, input);
    case 'instant':
      return matchesInstant(predicate, input);
    case 'closure':
      return matchesClosure(predicate, input);
  }
}

/** A rule's predicate conjunction — every predicate must hold (contracts/evaluation.md step 2). */
export function matchesConjunction(predicates: PredicateConjunction, input: DecisionInput): boolean {
  return predicates.every((predicate) => matchesPredicate(predicate, input));
}
