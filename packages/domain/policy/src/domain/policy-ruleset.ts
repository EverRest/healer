import { createHash } from 'node:crypto';
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

/** The exact fields the digest is computed over, in a fixed key order — so two rule bodies that
 *  are structurally identical hash identically regardless of the key order a caller happened to
 *  write the object literal in (the same reasoning `fingerprint.ts` and `tool-call-digest.ts`
 *  apply to their own hashed payloads). */
function canonicalRuleBody(rule: RuleBody): Readonly<Record<string, unknown>> {
  return {
    ruleKey: rule.ruleKey,
    predicates: rule.predicates,
    outcome: rule.outcome,
    reasonCode: rule.reasonCode,
    note: rule.note,
  };
}

/**
 * Content hash over the rule bodies **in the order given** (data-model.md: "content hash over the
 * ordered rule bodies"). This is deliberately order-*sensitive*: publishing the same rules in a
 * different order produces a different digest and therefore a new version — R-01's "identical
 * content is a no-op" is about byte-identical content, not about the order-independence of
 * *evaluation*, which `evaluate()` already guarantees regardless of storage order (R-04, proved
 * again at this layer by T018). sha256/hex over canonical JSON, the same primitives this
 * repository already uses for content-addressing elsewhere (`fingerprint.ts`,
 * `tool-call-digest.ts`) — no new dependency.
 */
export function computeRulesetDigest(rules: readonly RuleBody[]): string {
  return createHash('sha256').update(JSON.stringify(rules.map(canonicalRuleBody))).digest('hex');
}

export type { ConflictWarning };
