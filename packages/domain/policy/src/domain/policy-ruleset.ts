import { createHash } from 'node:crypto';
import { HealerError } from '@healer/shared';
import { canonicalize } from './canonicalize.js';
import type { Outcome } from './outcome-lattice.js';
import { validatePredicateShape } from './predicates/validate.js';
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

/**
 * Review finding: nothing upstream rejected two rules sharing a `ruleKey` within one publish
 * call — such a request reached `PrismaPolicyRulesetRepository.publish()`, hit `policy_rule`'s
 * own `@@unique([rulesetId, ruleKey])` constraint as a P2002, and — before the repository's P2002
 * handling was narrowed to only the ruleset table's own constraints — was misdiagnosed as a
 * version race and burned every retry attempt against a request that could never succeed.
 * `ruleKey` is "stable across versions, so a rule can be followed through history"
 * (data-model.md) — duplicating one within a single publish is a caller error, not a race,
 * and cheaper to reject here, before any digest or DB work, than to discover via a raw
 * constraint failure three layers down.
 */
export class DuplicateRuleKeyError extends HealerError {
  constructor(readonly ruleKey: string) {
    super('VALIDATION', `rule key "${ruleKey}" appears more than once in this rule set`);
    this.name = 'DuplicateRuleKeyError';
  }
}

export function assertUniqueRuleKeys(rules: readonly RuleBody[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.ruleKey)) throw new DuplicateRuleKeyError(rule.ruleKey);
    seen.add(rule.ruleKey);
  }
}

/** Batch 9 I2, review finding: publish-time predicate validation used to exist only at the HTTP
 *  DTO edge (`apps/api/src/policy/publish-ruleset.dto.ts`) — an in-process publish (a seed script,
 *  011's future simulator) could store a rule set that makes `evaluate()` throw. `RULESET_INVALID`
 *  has no entry in `@healer/shared`'s closed `ErrorCode` union, so this maps to `VALIDATION`, the
 *  same substitution `DuplicateRuleKeyError` above already makes and the DTO's own header already
 *  flags for the HTTP boundary. */
export class RulesetPredicateInvalidError extends HealerError {
  constructor(
    readonly ruleKey: string,
    readonly reason: string,
  ) {
    super('VALIDATION', `rule "${ruleKey}": ${reason}`);
    this.name = 'RulesetPredicateInvalidError';
  }
}

export function assertValidPredicates(rules: readonly RuleBody[]): void {
  for (const rule of rules) {
    for (const predicate of rule.predicates) {
      const violation = validatePredicateShape(predicate);
      if (violation !== null) throw new RulesetPredicateInvalidError(rule.ruleKey, violation);
    }
  }
}

export type { ConflictWarning };
