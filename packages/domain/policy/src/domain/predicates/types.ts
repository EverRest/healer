import type {
  BooleanField,
  ClosureField,
  EnumeratedField,
  IdentifierField,
  InstantField,
  OrdinalField,
  QuantityField,
} from './fields.js';

// T010: one predicate type per field-type group, each carrying only the operators its domain
// permits (contracts/evaluation.md's operator-domain table) — an operator outside a field's
// domain is a type error here, not a runtime check (the "unsafe state unrepresentable" pattern,
// 00-core.md).

export interface EnumeratedPredicate {
  readonly kind: 'enumerated';
  readonly field: EnumeratedField;
  readonly operator: 'equals' | 'notEquals';
  readonly value: string;
}

export interface EnumeratedSetPredicate {
  readonly kind: 'enumerated';
  readonly field: EnumeratedField;
  readonly operator: 'in' | 'notIn';
  readonly value: readonly string[];
}

export interface IdentifierEqualsPredicate {
  readonly kind: 'identifier';
  readonly field: IdentifierField;
  readonly operator: 'equals';
  readonly value: string;
}

export interface IdentifierSetPredicate {
  readonly kind: 'identifier';
  readonly field: IdentifierField;
  readonly operator: 'in' | 'notIn';
  readonly value: readonly string[];
}

export interface BooleanPredicate {
  readonly kind: 'boolean';
  readonly field: BooleanField;
  readonly operator: 'isTrue' | 'isFalse';
}

export interface OrdinalPredicate {
  readonly kind: 'ordinal';
  readonly field: OrdinalField;
  readonly operator: 'atLeast' | 'atMost' | 'equals';
  readonly value: number;
}

/** A quantity may be compared against a literal or against another field in the same group —
 *  never against a computed expression (contracts/evaluation.md operator-domain table). */
export type QuantityValue =
  | { readonly kind: 'literal'; readonly value: number }
  | { readonly kind: 'field'; readonly field: QuantityField };

export interface QuantityPredicate {
  readonly kind: 'quantity';
  readonly field: QuantityField;
  readonly operator: 'atLeast' | 'atMost';
  readonly value: QuantityValue;
}

export interface InstantPredicate {
  readonly kind: 'instant';
  readonly field: InstantField;
  readonly operator: 'before' | 'after';
  /** ISO 8601 literal supplied in the rule — never another field, never the clock (R-02). */
  readonly value: string;
}

export interface ClosureSetPredicate {
  readonly kind: 'closure';
  readonly field: ClosureField;
  readonly operator: 'containsNoneOf' | 'subsetOf';
  readonly value: readonly string[];
}

export interface ClosureBoundPredicate {
  readonly kind: 'closure';
  readonly field: ClosureField;
  readonly operator: 'sizeAtMost' | 'maxDepthAtMost';
  readonly value: number;
}

export type Predicate =
  | EnumeratedPredicate
  | EnumeratedSetPredicate
  | IdentifierEqualsPredicate
  | IdentifierSetPredicate
  | BooleanPredicate
  | OrdinalPredicate
  | QuantityPredicate
  | InstantPredicate
  | ClosureSetPredicate
  | ClosureBoundPredicate;

/** A rule is a conjunction: every predicate must hold (contracts/evaluation.md step 2 — no
 *  ordering, no priority). */
export type PredicateConjunction = readonly Predicate[];
