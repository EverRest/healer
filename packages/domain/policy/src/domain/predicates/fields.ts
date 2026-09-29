// T010: the closed predicate vocabulary's field lists — exactly the operator-domain table of
// contracts/evaluation.md (C-19, the single authority). Grouping fields by type here, rather than
// looking the type up at runtime from a field name, is what makes an operator outside a field's
// domain a compile error instead of a check someone could forget (predicate-types.ts builds the
// per-kind predicate unions from these lists).

export const ENUMERATED_FIELDS = [
  'target.environment',
  'target.issueKind',
  'issue.classification',
  'impact.classification',
  'action.actionClass',
  'reproduction.outcome',
  'issue.state',
  'eligibility.codeProblemVerdict',
] as const;
export type EnumeratedField = (typeof ENUMERATED_FIELDS)[number];

// No hierarchy operator (`descendantOf` is deliberately absent, C-16): reading the graph inside
// the fold made stored decisions unreplayable, because the graph mutates on every confirmation.
export const IDENTIFIER_FIELDS = [
  'target.componentId',
  'target.targetRef',
  'target.fingerprint',
  'action.actionKey',
] as const;
export type IdentifierField = (typeof IDENTIFIER_FIELDS)[number];

export const BOOLEAN_FIELDS = [
  'evidence.complete',
  'evidence.conclusionHasLink',
  'reversibility.reversible',
  'reversibility.hasTestedUndo',
  'eligibility.fixEligible',
  'impact.touchesPublicContract',
  'impact.touchesMigration',
  'impact.touchesAuthPath',
  'impact.touchesMoneyPath',
] as const;
export type BooleanField = (typeof BOOLEAN_FIELDS)[number];

// A rule states the level it requires with `autonomy.level atLeast N` — there is no separate
// autonomy step in the evaluation order (C-17).
export const ORDINAL_FIELDS = ['autonomy.level', 'budget.degradationStep'] as const;
export type OrdinalField = (typeof ORDINAL_FIELDS)[number];

export const QUANTITY_FIELDS = [
  'budget.consumed',
  'budget.limit',
  'budget.declaredMaxCost',
  'cooldown.recentAllowCount',
  'cooldown.attemptCount',
  'escalation.attemptCount',
] as const;
export type QuantityField = (typeof QUANTITY_FIELDS)[number];

// Compared only against a literal supplied in the rule — the evaluator reads no clock (R-02).
export const INSTANT_FIELDS = ['evaluatedAt'] as const;
export type InstantField = (typeof INSTANT_FIELDS)[number];

// Antitone only: `containsAnyOf` / `intersects` / any existential form is deliberately absent
// (C-03, C-19) — an existential is satisfied *by adding an edge*.
export const CLOSURE_FIELDS = ['impact.closure'] as const;
export type ClosureField = (typeof CLOSURE_FIELDS)[number];
