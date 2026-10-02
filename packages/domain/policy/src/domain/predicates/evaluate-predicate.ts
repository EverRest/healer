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
import { parseInstantLiteral } from './instant-literal.js';
import type { Predicate, PredicateConjunction, QuantityValue } from './types.js';

// Throws rather than falling through — matches `field-access.ts`'s `unreachable()` pattern. An
// out-of-vocabulary `kind` or `operator` can only reach here through a bad deserialization or a
// bypass of T006's schema (publish-time validation, T019, is meant to catch this before it gets
// this far); a silent fallback here would misevaluate a predicate instead of surfacing the
// corruption — for a DENY-outcome rule specifically, that direction of silence is a restrictive
// rule that quietly stops matching.
function unreachable(value: never): never {
  throw new Error(`unreachable predicate shape: ${JSON.stringify(value)}`);
}

function resolveQuantityValue(value: QuantityValue, input: DecisionInput): number {
  switch (value.kind) {
    case 'literal':
      return value.value;
    case 'field':
      return readQuantityField(value.field, input);
    default:
      return unreachable(value);
  }
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
    default:
      return unreachable(predicate);
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
    default:
      return unreachable(predicate);
  }
}

function matchesBoolean(
  predicate: Extract<Predicate, { kind: 'boolean' }>,
  input: DecisionInput,
): boolean {
  const actual = readBooleanField(predicate.field, input);
  switch (predicate.operator) {
    case 'isTrue':
      return actual;
    case 'isFalse':
      return !actual;
    default:
      return unreachable(predicate.operator);
  }
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
    default:
      return unreachable(predicate.operator);
  }
}

function matchesQuantity(
  predicate: Extract<Predicate, { kind: 'quantity' }>,
  input: DecisionInput,
): boolean {
  const actual = readQuantityField(predicate.field, input);
  const target = resolveQuantityValue(predicate.value, input);
  switch (predicate.operator) {
    case 'atLeast':
      return actual >= target;
    case 'atMost':
      return actual <= target;
    default:
      return unreachable(predicate.operator);
  }
}

function matchesInstant(
  predicate: Extract<Predicate, { kind: 'instant' }>,
  input: DecisionInput,
): boolean {
  const actual = readInstantField(predicate.field, input).getTime();
  const literal = parseInstantLiteral(predicate.value);
  switch (predicate.operator) {
    case 'before':
      return actual < literal;
    case 'after':
      return actual > literal;
    default:
      return unreachable(predicate.operator);
  }
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
    default:
      return unreachable(predicate);
  }
}

/** `(predicate, input) → boolean`. Total: a well-typed predicate over a schema-valid
 *  `DecisionInput` never throws for a value the type system permits (T010) — a runtime type
 *  mismatch that reaches the `default` branches above is what T006's schema (and later T019's
 *  publish-time validation) should already have rejected; this layer refuses to misevaluate it
 *  silently instead. */
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
    default:
      return unreachable(predicate);
  }
}

/** A rule's predicate conjunction — every predicate must hold (contracts/evaluation.md step 2). */
export function matchesConjunction(
  predicates: PredicateConjunction,
  input: DecisionInput,
): boolean {
  return predicates.every((predicate) => matchesPredicate(predicate, input));
}
