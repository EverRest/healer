import { describe, expect, it } from 'vitest';
import { computeRulesetDigest, type RuleBody } from './policy-ruleset.js';

// Review finding: the original digest only canonicalized each rule body's own top-level fields,
// not the objects nested inside `predicates` — so two predicates differing only in the order
// their literal keys were written (or a rule read back from a `jsonb` column, which does not
// preserve insertion order) hashed differently, silently minting a spurious new version instead
// of hitting R-01's no-op path.
describe('computeRulesetDigest — canonicalization reaches nested predicate objects', () => {
  it('two rule bodies with byte-identical content but different predicate key order hash identically', () => {
    const a: RuleBody = {
      ruleKey: 'allow-prod',
      predicates: [{ kind: 'enumerated', field: 'target.environment', operator: 'equals', value: 'prod' }],
      outcome: 'allow',
      reasonCode: 'NO_ADOPTED_EXPECTATION',
      note: '',
    };
    const b: RuleBody = {
      ruleKey: 'allow-prod',
      // Same predicate, different literal key-write order — this is exactly what a `jsonb`
      // round trip through Postgres can also produce, since jsonb does not preserve insertion
      // order.
      predicates: [{ field: 'target.environment', kind: 'enumerated', value: 'prod', operator: 'equals' }],
      outcome: 'allow',
      reasonCode: 'NO_ADOPTED_EXPECTATION',
      note: '',
    };

    expect(computeRulesetDigest([a])).toBe(computeRulesetDigest([b]));
  });

  it('a rule set built by writing every top-level field in reverse order still hashes identically', () => {
    const a: RuleBody = {
      ruleKey: 'deny-x',
      predicates: [],
      outcome: 'deny',
      reasonCode: 'TARGET_BLOCKED',
      note: 'blocked',
    };
    // Same values, top-level object literal written key-reversed.
    const b = {
      note: 'blocked',
      reasonCode: 'TARGET_BLOCKED',
      outcome: 'deny',
      predicates: [],
      ruleKey: 'deny-x',
    } as RuleBody;

    expect(computeRulesetDigest([a])).toBe(computeRulesetDigest([b]));
  });

  it('genuinely different predicate content still hashes differently', () => {
    const a: RuleBody = {
      ruleKey: 'allow-prod',
      predicates: [{ kind: 'enumerated', field: 'target.environment', operator: 'equals', value: 'prod' }],
      outcome: 'allow',
      reasonCode: 'NO_ADOPTED_EXPECTATION',
      note: '',
    };
    const b: RuleBody = {
      ruleKey: 'allow-prod',
      predicates: [{ kind: 'enumerated', field: 'target.environment', operator: 'equals', value: 'staging' }],
      outcome: 'allow',
      reasonCode: 'NO_ADOPTED_EXPECTATION',
      note: '',
    };

    expect(computeRulesetDigest([a])).not.toBe(computeRulesetDigest([b]));
  });
});
