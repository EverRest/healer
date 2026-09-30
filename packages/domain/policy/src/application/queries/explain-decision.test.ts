import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import type { ReadOnlyPolicyRulesetRepository, PublishedRuleset } from '../../domain/policy-ruleset-repository.js';
import { buildDecisionInput } from '../../domain/test-support/fixtures.js';
import { NoPublishedRulesetError } from '../resolve-ruleset-and-evaluate.js';
import { explainDecision, type ExplainDecisionRepos } from './explain-decision.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000d2');

function published(overrides: Partial<PublishedRuleset> = {}): PublishedRuleset {
  return {
    id: 'ruleset-1',
    version: 1,
    digest: 'digest-1',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    publishedBy: 'pavlo',
    conflictWarnings: [],
    rules: [
      {
        ruleKey: 'allow-code-change',
        predicates: [{ kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' }],
        outcome: 'allow',
        reasonCode: 'NO_ADOPTED_EXPECTATION',
        note: '',
      },
    ],
    ...overrides,
  };
}

/** T026: a fake that implements *only* `ReadOnlyPolicyRulesetRepository` — no `publish` method
 *  exists on this object at all, unlike `PrismaPolicyRulesetRepository` or the `FakeRulesetRepo`
 *  batch 5 uses for `EvaluateAndBind`'s tests. If `explainDecision` ever needed a write-capable
 *  repository method, this fake could not satisfy its parameter type and this file would fail to
 *  typecheck — that failure, not a runtime assertion, is the actual guarantee (see the two checks
 *  below for what that guarantee reduces to in a test). */
class ReadOnlyFakeRulesetRepo implements ReadOnlyPolicyRulesetRepository {
  constructor(private readonly ruleset: PublishedRuleset | null) {}
  async findByDigest(): Promise<PublishedRuleset | null> {
    return this.ruleset;
  }
  async findLatest(): Promise<PublishedRuleset | null> {
    return this.ruleset;
  }
}

describe('ExplainDecision — structural read-only guarantee (T026, R-08, quickstart 32)', () => {
  it('ReadOnlyPolicyRulesetRepository, the only type ExplainDecisionRepos names, has no write-shaped method', () => {
    const repo = new ReadOnlyFakeRulesetRepo(published());
    for (const mutatingMethod of ['publish', 'create', 'update', 'delete', 'save', 'remove', 'write']) {
      expect(mutatingMethod in repo).toBe(false);
    }
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(repo))).toEqual(
      expect.arrayContaining(['findByDigest', 'findLatest']),
    );
  });

  it('a repos value typed as ExplainDecisionRepos cannot reach `.publish` — compile-time, not runtime', () => {
    const repos: ExplainDecisionRepos = { rulesets: new ReadOnlyFakeRulesetRepo(published()) };
    // @ts-expect-error — `rulesets` is `ReadOnlyPolicyRulesetRepository`; `publish` is not a
    // member of that type. If this stops being a type error (e.g. someone widens
    // `ExplainDecisionRepos.rulesets` back to `PolicyRulesetRepository`), `tsc` fails on the
    // now-unused `@ts-expect-error` directive — this is what "structural, not a flag" means
    // enforced by the compiler on every `pnpm run typecheck`.
    const _unreachable = repos.rulesets.publish;
    void _unreachable;
  });
});

describe('explainDecision (T024)', () => {
  it('returns the decision and trace for the current published ruleset, persisting nothing observable to this handler', async () => {
    const result = await explainDecision(
      { rulesets: new ReadOnlyFakeRulesetRepo(published()) },
      CONTEXT,
      { decisionInput: buildDecisionInput() },
    );
    expect(result.decision.outcome).toBe('allow');
    expect(result.decision.rulesetVersion).toBe(1);
    expect(result.trace.matchedRules).toEqual([{ ruleKey: 'allow-code-change', outcome: 'allow' }]);
  });

  it('refuses when no ruleset has ever been published for the tenant', async () => {
    await expect(
      explainDecision({ rulesets: new ReadOnlyFakeRulesetRepo(null) }, CONTEXT, { decisionInput: buildDecisionInput() }),
    ).rejects.toThrow(NoPublishedRulesetError);
  });
});
