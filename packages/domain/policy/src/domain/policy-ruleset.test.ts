import { describe, expect, it } from 'vitest';
import { assertUniqueRuleKeys, computeRulesetDigest, DuplicateRuleKeyError, type RuleBody } from './policy-ruleset.js';

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

// Review finding: nothing rejected two rules sharing a `ruleKey` within one publish call before
// it reached `policy_rule`'s own `@@unique([rulesetId, ruleKey])` constraint, three layers down
// and misdiagnosed by the repository's P2002 handling as a version race.
describe('assertUniqueRuleKeys (review finding)', () => {
  function rule(ruleKey: string): RuleBody {
    return { ruleKey, predicates: [], outcome: 'allow', reasonCode: 'NO_ADOPTED_EXPECTATION', note: '' };
  }

  it('accepts a rule set with no duplicate ruleKeys', () => {
    expect(() => assertUniqueRuleKeys([rule('a'), rule('b'), rule('c')])).not.toThrow();
  });

  it('accepts the empty rule set', () => {
    expect(() => assertUniqueRuleKeys([])).not.toThrow();
  });

  it('rejects two rules sharing a ruleKey, naming the duplicate', () => {
    expect(() => assertUniqueRuleKeys([rule('a'), rule('b'), rule('a')])).toThrow(DuplicateRuleKeyError);
    try {
      assertUniqueRuleKeys([rule('a'), rule('b'), rule('a')]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateRuleKeyError);
      expect((error as DuplicateRuleKeyError).ruleKey).toBe('a');
      expect((error as DuplicateRuleKeyError).code).toBe('VALIDATION');
    }
  });

  it('rejects three-or-more-way duplication, not only exact pairs', () => {
    expect(() => assertUniqueRuleKeys([rule('a'), rule('a'), rule('a')])).toThrow(DuplicateRuleKeyError);
  });
});
