import type { Predicate, PredicateConjunction } from './predicates/types.js';
import type { Rule } from './rule.js';

// T019/T020: `PublishRuleset` computes `conflict_warnings` — rule pairs that can *both* match on
// some input with *different* outcomes (data-model.md `policy_ruleset.conflict_warnings`, FR-006).
//
// Not exhaustive SAT-solving over the predicate language — a pairwise per-field overlap check.
// For each field mentioned by *both* rules, it asks "is there a value that could satisfy both
// rules' constraints on this field?" using the same finite-set/range reasoning for every field
// type this batch can resolve statically (enumerated, identifier, boolean, ordinal). It proves
// disjointness — "no, these two can never both match" — only from those field kinds; when it
// cannot prove disjointness it reports a warning, which is the safe direction to be wrong in (an
// extra warning is a false alarm a human dismisses; a missed one is the silent conflict FR-006
// exists to surface).
//
// **What this does not catch** (documented, not hidden):
// - quantity fields (`budget.consumed` compared against a literal *or* another field),
//   instant fields (`evaluatedAt`) and closure fields (`impact.closure`) are never used to prove
//   disjointness — two rules constraining only these are always reported as a possible conflict,
//   even when the actual predicates happen to be disjoint (e.g. `budget.consumed atLeast 100` vs
//   `budget.consumed atMost 50` — a case this function does not attempt to resolve).
// - two rules constrained *only* by exclusions (`notEquals`/`notIn`, no `equals`/`in`) on the same
//   field are always reported as a possible conflict: without knowing the field's whole domain,
//   "excludes X" and "excludes Y" cannot be shown disjoint from each other.
// - cross-field relationships (a value legal in field A only in combination with a value in field
//   B) are invisible here: each field is checked independently, so a real interaction between two
//   fields cannot be discovered as a source of *safety*, only ever as a source of "cannot prove
//   disjoint, so warn."
export interface ConflictWarning {
  readonly ruleKeyA: string;
  readonly ruleKeyB: string;
}

type SetField = Extract<Predicate, { kind: 'enumerated' | 'identifier' }>;
type BooleanFieldPredicate = Extract<Predicate, { kind: 'boolean' }>;
type OrdinalFieldPredicate = Extract<Predicate, { kind: 'ordinal' }>;

/** The value set a rule's own predicates on one field resolve to: `closed` when at least one
 *  `equals`/`in` predicate pins it to a finite set (minus any exclusions), `open` when only
 *  exclusions are present — in which case the "allowed" set is every value outside `excluded`,
 *  which cannot be enumerated without knowing the field's domain. */
type ValueSet =
  | { readonly closed: true; readonly values: ReadonlySet<string> }
  | { readonly closed: false; readonly excluded: ReadonlySet<string> };

function intersectMaybe(a: ReadonlySet<string> | undefined, b: ReadonlySet<string>): Set<string> {
  if (!a) return new Set(b);
  return new Set([...a].filter((v) => b.has(v)));
}

function resolveValueSet(preds: readonly SetField[]): ValueSet {
  let positive: Set<string> | undefined;
  const excluded = new Set<string>();
  for (const p of preds) {
    if (p.operator === 'equals') positive = intersectMaybe(positive, new Set([p.value]));
    else if (p.operator === 'in') positive = intersectMaybe(positive, new Set(p.value));
    else if (p.operator === 'notEquals') excluded.add(p.value);
    else if (p.operator === 'notIn') for (const v of p.value) excluded.add(v);
  }
  if (positive)
    return { closed: true, values: new Set([...positive].filter((v) => !excluded.has(v))) };
  return { closed: false, excluded };
}

function disjointSets(a: ValueSet, b: ValueSet): boolean {
  if (a.closed && b.closed) return [...a.values].every((v) => !b.values.has(v));
  if (a.closed && !b.closed) return [...a.values].every((v) => b.excluded.has(v));
  if (!a.closed && b.closed) return [...b.values].every((v) => a.excluded.has(v));
  return false; // both open-ended: cannot prove disjoint from exclusions alone (documented gap).
}

function disjointBoolean(
  aPreds: readonly BooleanFieldPredicate[],
  bPreds: readonly BooleanFieldPredicate[],
): boolean {
  const requires = (preds: readonly BooleanFieldPredicate[]) => ({
    true: preds.some((p) => p.operator === 'isTrue'),
    false: preds.some((p) => p.operator === 'isFalse'),
  });
  const a = requires(aPreds);
  const b = requires(bPreds);
  // A side requiring both true and false can itself never match — trivially disjoint from anything.
  if ((a.true && a.false) || (b.true && b.false)) return true;
  return (a.true && b.false) || (a.false && b.true);
}

function ordinalRange(preds: readonly OrdinalFieldPredicate[]): readonly [number, number] {
  let min = -Infinity;
  let max = Infinity;
  for (const p of preds) {
    if (p.operator === 'atLeast') min = Math.max(min, p.value);
    else if (p.operator === 'atMost') max = Math.min(max, p.value);
    else if (p.operator === 'equals') {
      min = Math.max(min, p.value);
      max = Math.min(max, p.value);
    }
  }
  return [min, max];
}

function disjointOrdinal(
  aPreds: readonly OrdinalFieldPredicate[],
  bPreds: readonly OrdinalFieldPredicate[],
): boolean {
  const [aMin, aMax] = ordinalRange(aPreds);
  const [bMin, bMax] = ordinalRange(bPreds);
  return aMax < bMin || bMax < aMin;
}

/** True when this field, given both rules' own constraints on it, provably admits no common
 *  value — the one case where the pair can be ruled out. Every other field kind (quantity,
 *  instant, closure) falls through to `false` ("not proven disjoint"), the documented gap above. */
function fieldsDisjoint(aPreds: PredicateConjunction, bPreds: PredicateConjunction): boolean {
  const kind = aPreds[0]?.kind;
  switch (kind) {
    case 'enumerated':
    case 'identifier':
      return disjointSets(
        resolveValueSet(aPreds as readonly SetField[]),
        resolveValueSet(bPreds as readonly SetField[]),
      );
    case 'boolean':
      return disjointBoolean(
        aPreds as readonly BooleanFieldPredicate[],
        bPreds as readonly BooleanFieldPredicate[],
      );
    case 'ordinal':
      return disjointOrdinal(
        aPreds as readonly OrdinalFieldPredicate[],
        bPreds as readonly OrdinalFieldPredicate[],
      );
    default:
      return false;
  }
}

/** Whether two rules' predicate conjunctions could hold for the same input — the question
 *  `computeConflictWarnings` asks of every differently-outcomed pair. */
export function couldBothMatch(a: PredicateConjunction, b: PredicateConjunction): boolean {
  const fields = new Set([...a, ...b].map((p) => p.field));
  for (const field of fields) {
    const aPreds = a.filter((p) => p.field === field);
    const bPreds = b.filter((p) => p.field === field);
    // A field only one side constrains imposes nothing on the other — never a source of
    // disjointness on its own.
    if (aPreds.length === 0 || bPreds.length === 0) continue;
    if (fieldsDisjoint(aPreds, bPreds)) return false;
  }
  return true;
}

/** Every unordered pair of rules with different outcomes that this check cannot rule out as
 *  mutually exclusive (FR-006, quickstart 6). Order of the input array does not affect the
 *  result — each pair is considered once regardless of position. */
export function computeConflictWarnings(rules: readonly Rule[]): readonly ConflictWarning[] {
  const warnings: ConflictWarning[] = [];
  for (const [i, a] of rules.entries()) {
    for (const b of rules.slice(i + 1)) {
      if (a.outcome === b.outcome) continue;
      if (couldBothMatch(a.predicates, b.predicates)) {
        warnings.push({ ruleKeyA: a.ruleKey, ruleKeyB: b.ruleKey });
      }
    }
  }
  return warnings;
}
