import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import type {
  ReadOnlyPolicyRulesetRepository,
  PublishedRuleset,
} from '../../domain/policy-ruleset-repository.js';
import { buildDecisionInput } from '../../domain/test-support/fixtures.js';
import { replayDecision, RulesetVersionNotFoundError } from './replay-decision.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000d3');

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
        predicates: [
          {
            kind: 'enumerated',
            field: 'action.actionClass',
            operator: 'equals',
            value: 'code_change',
          },
        ],
        outcome: 'allow',
        reasonCode: 'NO_ADOPTED_EXPECTATION',
        note: '',
      },
    ],
    ...overrides,
  };
}

class FakeRulesetRepo implements ReadOnlyPolicyRulesetRepository {
  constructor(private readonly byVersion: Map<number, PublishedRuleset>) {}
  async findByDigest(): Promise<PublishedRuleset | null> {
    return null;
  }
  async findLatest(): Promise<PublishedRuleset | null> {
    return null;
  }
  async findByVersion(where: { readonly version: number }): Promise<PublishedRuleset | null> {
    return this.byVersion.get(where.version) ?? null;
  }
  async list(): Promise<readonly PublishedRuleset[]> {
    return [...this.byVersion.values()];
  }
}

describe('replayDecision (T028, FR-002)', () => {
  it("resolves the historical ruleset version, not the tenant's current one, and reports an identical outcome", async () => {
    const repos = { rulesets: new FakeRulesetRepo(new Map([[1, published()]])) };
    const result = await replayDecision(repos, CONTEXT, {
      decisionInput: buildDecisionInput(),
      rulesetVersion: 1,
      outcome: 'allow',
    });
    expect(result.identical).toBe(true);
    expect(result.replayed.outcome).toBe('allow');
  });

  it('reports (not throws) a differing outcome — an incident, not a test failure', async () => {
    const repos = { rulesets: new FakeRulesetRepo(new Map([[1, published()]])) };
    const result = await replayDecision(repos, CONTEXT, {
      decisionInput: buildDecisionInput(),
      rulesetVersion: 1,
      outcome: 'deny',
    });
    expect(result.identical).toBe(false);
    expect(result.replayed.outcome).toBe('allow');
  });

  it('resolves version 1 even when a materially different version 2 has since superseded it (SC-003)', async () => {
    // A conflicting rule set: what v1 says ALLOW, v2 says DENY. If replayDecision ever resolved
    // "latest" instead of the decision's own recorded version, this would silently flip the
    // reported outcome — the exact regression this test exists to catch.
    const v1 = published({ id: 'ruleset-1', version: 1 });
    const v2 = published({
      id: 'ruleset-2',
      version: 2,
      supersedesVersion: 1,
      rules: [{ ...v1.rules[0]!, outcome: 'deny' }],
    });
    const repos = { rulesets: new FakeRulesetRepo(new Map([[1, v1], [2, v2]])) };

    const result = await replayDecision(repos, CONTEXT, {
      decisionInput: buildDecisionInput(),
      rulesetVersion: 1,
      outcome: 'allow',
    });

    expect(result.identical).toBe(true);
    expect(result.replayed.outcome).toBe('allow');
    expect(result.replayed.rulesetVersion).toBe(1);
  });

  it('throws when the cited ruleset version no longer resolves', async () => {
    const repos = { rulesets: new FakeRulesetRepo(new Map()) };
    await expect(
      replayDecision(repos, CONTEXT, {
        decisionInput: buildDecisionInput(),
        rulesetVersion: 9,
        outcome: 'allow',
      }),
    ).rejects.toThrow(RulesetVersionNotFoundError);
  });
});
