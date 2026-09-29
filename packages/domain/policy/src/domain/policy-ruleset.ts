import { createHash } from 'node:crypto';
import { canonicalize } from './canonicalize.js';
import type { Outcome } from './outcome-lattice.js';
import type { PredicateConjunction } from './predicates/types.js';
import type { ReasonCode } from './reason-code.js';
import { type ConflictWarning } from './conflict-warnings.js';

// T019: `PublishRuleset` is content-addressed over the *ordered* rule bodies (data-model.md
// `policy_ruleset.digest`). A `RuleBody` is what a publish call supplies for one rule — `Rule`
// (rule.ts) plus `note`, the tenant-facing text `evaluate()` itself never reads.
export interface RuleBody {
  readonly ruleKey: string;
  readonly predicates: PredicateConjunction;
  readonly outcome: Outcome;
  readonly reasonCode: ReasonCode;
  readonly note: string;
}

/**
 * Content hash over the rule bodies **in the order given** (data-model.md: "content hash over the
 * ordered rule bodies"). This is deliberately order-*sensitive* at the top level: publishing the
 * same rules in a different order produces a different digest and therefore a new version —
 * R-01's "identical content is a no-op" is about byte-identical content, not about the
 * order-independence of *evaluation*, which `evaluate()` already guarantees regardless of storage
 * order (R-04, proved again at this layer by T018).
 *
 * `canonicalize` (shared with `proposal-digest.ts`) sorts every object's keys **at every depth**
 * — not just each rule body's own top-level fields, but every predicate object inside its
 * `predicates` array too (review finding: the original version fixed only the top level, so two
 * predicates differing only in literal key-write-order, or a rule read back from a `jsonb`
 * column — which does not preserve insertion order — could hash differently from the content
 * that was actually published, breaking the no-op guarantee for exactly that path). Only object
 * *key order* is normalised; the rule *array's own order* is untouched, which is what keeps this
 * digest order-sensitive as intended.
 */
export function computeRulesetDigest(rules: readonly RuleBody[]): string {
  const canonical = rules.map((rule) =>
    canonicalize({
      ruleKey: rule.ruleKey,
      predicates: rule.predicates,
      outcome: rule.outcome,
      reasonCode: rule.reasonCode,
      note: rule.note,
    }),
  );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export type { ConflictWarning };
