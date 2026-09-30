// T019/batch 9 I2 (review finding): publish-time validation of the predicate vocabulary, derived
// from the same field lists `evaluate-predicate.ts` already reads (`fields.ts`) rather than a
// second hand-copied table — contracts/evaluation.md's operator-domain table names `fields.ts` as
// "the single authority" (C-19), and until this file existed, the only runtime copy of the
// operator-domain table lived in `apps/api/src/policy/publish-ruleset.dto.ts`, untested and
// reachable only at the HTTP edge. `publishRuleset` (the domain command) now calls this too, so an
// in-process publish — a seed script, 011's future simulator — gets the same refusal an HTTP
// caller always did, instead of silently storing a rule set that makes `evaluate()` throw
// (`evaluate-predicate.ts`'s own `unreachable()` comment: "publish-time validation... is meant to
// catch this before it gets this far").
import {
  BOOLEAN_FIELDS,
  CLOSURE_FIELDS,
  ENUMERATED_FIELDS,
  IDENTIFIER_FIELDS,
  INSTANT_FIELDS,
  ORDINAL_FIELDS,
  QUANTITY_FIELDS,
} from './fields.js';
import type { Predicate } from './types.js';

export type PredicateKind = Predicate['kind'];

const FIELD_KIND = new Map<string, PredicateKind>([
  ...ENUMERATED_FIELDS.map((f): [string, PredicateKind] => [f, 'enumerated']),
  ...IDENTIFIER_FIELDS.map((f): [string, PredicateKind] => [f, 'identifier']),
  ...BOOLEAN_FIELDS.map((f): [string, PredicateKind] => [f, 'boolean']),
  ...ORDINAL_FIELDS.map((f): [string, PredicateKind] => [f, 'ordinal']),
  ...QUANTITY_FIELDS.map((f): [string, PredicateKind] => [f, 'quantity']),
  ...INSTANT_FIELDS.map((f): [string, PredicateKind] => [f, 'instant']),
  ...CLOSURE_FIELDS.map((f): [string, PredicateKind] => [f, 'closure']),
]);

/** The single runtime authority for "which operators a field's kind permits"
 *  (contracts/evaluation.md's operator-domain table) — `predicates/types.ts` encodes the same
 *  domains as compile-time discriminated unions, which a `tsc`-checked caller can't violate; this
 *  is the same table for a caller that isn't type-checked (JSON off the wire, a script). */
export const OPERATORS_BY_KIND: Record<PredicateKind, readonly string[]> = {
  enumerated: ['equals', 'notEquals', 'in', 'notIn'],
  identifier: ['equals', 'in', 'notIn'],
  boolean: ['isTrue', 'isFalse'],
  ordinal: ['atLeast', 'atMost', 'equals'],
  quantity: ['atLeast', 'atMost'],
  instant: ['before', 'after'],
  closure: ['containsNoneOf', 'subsetOf', 'sizeAtMost', 'maxDepthAtMost'],
};

export function fieldKindOf(field: string): PredicateKind | undefined {
  return FIELD_KIND.get(field);
}

/** The prefix before the first `.` — `budget.consumed` and `budget.limit` are the same group;
 *  `budget.consumed` and `cooldown.attemptCount` are not (contracts/evaluation.md: a quantity
 *  "compared against a literal or against another field in the same group"). Deferred from batch 3
 *  to T019 per QUESTIONS.md ("002 T006-T013" item 5) and never actually picked up until now. */
function quantityGroup(field: string): string {
  const dot = field.indexOf('.');
  return dot === -1 ? field : field.slice(0, dot);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function wrongTypeMessage(field: string, operator: string): string {
  return `predicate value for field "${field}" operator "${operator}" has the wrong type`;
}

/** Exactly this set of own keys, no more, no less — the DTO's now-removed `VALUE_SCHEMA_BY_KIND_
 *  AND_OPERATOR` used `.strict()` for this; `validateQuantityValue` below is the only remaining
 *  place a `QuantityValue` gets checked at all (batch 9 follow-up review, round 3), so it takes
 *  over the same "no extra keys" guarantee rather than silently loosening it. */
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((k) => actual.includes(k));
}

/** `QuantityValue`'s own checks (batch 9 follow-up review, both independent Opus reviews):
 *  before this, `{kind:'field', field:'budget.degradationStep'}` passed for a `budget.consumed`
 *  predicate because both share the `budget.` string prefix — `budget.degradationStep` is an
 *  *ordinal* field, not a quantity one, and reached `evaluate()` unrejected, where it threw
 *  `unreachable field`. A bogus field name or an unrecognized `value.kind` (anything but
 *  `'literal'`/`'field'`) passed the same way — nothing checked `value` was even an object.
 *  `predicate.value`'s static type is the two-member `QuantityValue` union, but this function's
 *  whole job is validating callers that never went through `tsc` (JSON off the wire, a hand-built
 *  object in a script), so every branch here is a runtime check of a shape TypeScript alone
 *  cannot enforce for such a caller. */
function validateQuantityValue(field: string, operator: string, value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return wrongTypeMessage(field, operator);
  const kind = (value as { readonly kind?: unknown }).kind;
  if (kind === 'literal') {
    if (!hasExactKeys(value, ['kind', 'value'])) return wrongTypeMessage(field, operator);
    const literal = (value as { readonly value?: unknown }).value;
    return typeof literal === 'number' ? null : wrongTypeMessage(field, operator);
  }
  if (kind === 'field') {
    if (!hasExactKeys(value, ['kind', 'field'])) return wrongTypeMessage(field, operator);
    const targetField = (value as { readonly field?: unknown }).field;
    if (typeof targetField !== 'string') return wrongTypeMessage(field, operator);
    if (fieldKindOf(targetField) !== 'quantity') {
      return `quantity field "${field}" cannot be compared against "${targetField}" — "${targetField}" is not a quantity field`;
    }
    if (quantityGroup(field) !== quantityGroup(targetField)) {
      return `quantity field "${field}" cannot be compared against "${targetField}" — they are not in the same group`;
    }
    return null;
  }
  return `quantity value for field "${field}" has an unrecognized kind "${String(kind)}"`;
}

function validateSetOrScalarValue(
  field: string,
  operator: string,
  value: unknown,
): string | null {
  const isSet = operator === 'in' || operator === 'notIn';
  const valid = isSet ? isStringArray(value) : typeof value === 'string';
  return valid ? null : wrongTypeMessage(field, operator);
}

function validateInstantValue(field: string, operator: string, value: unknown): string | null {
  if (typeof value !== 'string') return wrongTypeMessage(field, operator);
  return Number.isNaN(new Date(value).getTime())
    ? `instant literal "${value}" for field "${field}" does not parse as a date`
    : null;
}

function validateClosureValue(field: string, operator: string, value: unknown): string | null {
  const isBound = operator === 'sizeAtMost' || operator === 'maxDepthAtMost';
  const valid = isBound ? typeof value === 'number' : isStringArray(value);
  return valid ? null : wrongTypeMessage(field, operator);
}

/** The value-shape half of `validatePredicateShape`, split out to keep both functions under the
 *  repo's complexity limit — one branch per predicate kind, each delegating to its own small
 *  checker rather than inlining the logic here. */
function validateValueType(predicate: Predicate): string | null {
  switch (predicate.kind) {
    case 'enumerated':
    case 'identifier':
      return validateSetOrScalarValue(predicate.field, predicate.operator, predicate.value);
    // Boolean predicates carry no `value` in the domain shape (`predicates/types.ts`) — nothing
    // to type-check.
    case 'boolean':
      return null;
    case 'ordinal':
      return typeof predicate.value === 'number'
        ? null
        : wrongTypeMessage(predicate.field, predicate.operator);
    case 'quantity':
      return validateQuantityValue(predicate.field, predicate.operator, predicate.value);
    case 'instant':
      return validateInstantValue(predicate.field, predicate.operator, predicate.value);
    case 'closure':
      return validateClosureValue(predicate.field, predicate.operator, predicate.value);
  }
}

/**
 * A predicate that is internally inconsistent — tagged with the wrong `kind` for its `field`, an
 * operator outside that kind's domain, a value of the wrong runtime type for its operator, an
 * instant literal that will never parse, or a quantity comparison against a non-quantity field or
 * one in a different group — would make `evaluate()` throw (`unreachable()`) or silently
 * misbehave at evaluation time, not at publish time, which is exactly what contracts/
 * evaluation.md's "a rule set that can fail to evaluate is not deterministic" rules out. Returns
 * the violation message, or `null` when the predicate is valid; never throws, so callers (the
 * domain `publishRuleset` command, the HTTP DTO) decide how to surface it.
 */
export function validatePredicateShape(predicate: Predicate): string | null {
  const kind = fieldKindOf(predicate.field);
  if (kind === undefined) return `unknown predicate field "${predicate.field}"`;
  if (kind !== predicate.kind) {
    return `field "${predicate.field}" is a "${kind}" field, but this predicate is tagged "${predicate.kind}"`;
  }
  if (!OPERATORS_BY_KIND[kind].includes(predicate.operator)) {
    return `operator "${predicate.operator}" is outside the domain of field "${predicate.field}"`;
  }
  return validateValueType(predicate);
}
