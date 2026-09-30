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

/**
 * A predicate that is internally inconsistent — tagged with the wrong `kind` for its `field`, an
 * operator outside that kind's domain, an instant literal that will never parse, or a quantity
 * comparison across groups — would make `evaluate()` throw (`unreachable()`) or silently
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
  if (predicate.kind === 'instant' && Number.isNaN(new Date(predicate.value).getTime())) {
    return `instant literal "${predicate.value}" for field "${predicate.field}" does not parse as a date`;
  }
  if (predicate.kind === 'quantity' && predicate.value.kind === 'field') {
    if (quantityGroup(predicate.field) !== quantityGroup(predicate.value.field)) {
      return (
        `quantity field "${predicate.field}" cannot be compared against ` +
        `"${predicate.value.field}" — they are not in the same group`
      );
    }
  }
  return null;
}
