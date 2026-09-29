import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import { evaluate } from '../../domain/evaluate.js';
import type { PolicyRulesetRepository, PublishedRuleset } from '../../domain/policy-ruleset-repository.js';
import type { RuleBody } from '../../domain/policy-ruleset.js';
import type { ResolvedRuleset, Rule } from '../../domain/rule.js';
import { buildDecisionInput } from '../../domain/test-support/fixtures.js';
import { publishRuleset } from './publish-ruleset.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000c1');

/** In-memory stand-in for `PolicyRulesetRepository` — no Postgres needed to prove
 *  `publishRuleset`'s own logic (digest no-op, version monotonicity, conflict warnings passed
 *  through). The real Prisma repository's transactional/immutability guarantees are proved
 *  against a real database in `policy-ruleset-repository.e2e.test.ts`. */
class FakeRulesetRepo implements PolicyRulesetRepository {
  private readonly byTenant = new Map<string, PublishedRuleset[]>();

  async findByDigest(where: TenantScoped<{ digest: string }>): Promise<PublishedRuleset | null> {
    const rows = this.byTenant.get(where.tenantId) ?? [];
    return rows.find((r) => r.digest === where.digest) ?? null;
  }

  async findLatest(where: TenantScoped<object>): Promise<PublishedRuleset | null> {
    const rows = this.byTenant.get(where.tenantId) ?? [];
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (b.version > a.version ? b : a));
  }

  async publish(
    where: TenantScoped<{
      id: string;
      version: number;
      digest: string;
      publishedAt: Date;
      publishedBy: string;
      supersedesVersion?: number;
      conflictWarnings: readonly { ruleKeyA: string; ruleKeyB: string }[];
      rules: readonly RuleBody[];
    }>,
  ): Promise<PublishedRuleset> {
    const row: PublishedRuleset = { ...where };
    const rows = this.byTenant.get(where.tenantId) ?? [];
    this.byTenant.set(where.tenantId, [...rows, row]);
    return row;
  }
}

function ruleBody(overrides: Partial<RuleBody>): RuleBody {
  return {
    ruleKey: 'r',
    predicates: [],
    outcome: 'allow',
    reasonCode: 'NO_ADOPTED_EXPECTATION',
    note: '',
    ...overrides,
  };
}

function asResolvedRuleset(published: PublishedRuleset): ResolvedRuleset {
  const rules: Rule[] = published.rules.map((r) => ({
    ruleKey: r.ruleKey,
    predicates: r.predicates,
    outcome: r.outcome,
    reasonCode: r.reasonCode,
  }));
  return { version: published.version, rules };
}

describe('publishRuleset — no-op and versioning (T019, R-01)', () => {
  it('publishing the same content twice is a no-op: same version, same digest, no new row', async () => {
    const repo = new FakeRulesetRepo();
    const rules = [ruleBody({ ruleKey: 'a' })];
    const first = await publishRuleset(repo, CONTEXT, { rules, publishedBy: 'pavlo' });
    const second = await publishRuleset(repo, CONTEXT, { rules, publishedBy: 'someone-else' });
    expect(second).toEqual(first);
  });

  it('changed content creates a new, monotone version, citing the version it supersedes', async () => {
    const repo = new FakeRulesetRepo();
    const v1 = await publishRuleset(repo, CONTEXT, { rules: [ruleBody({ ruleKey: 'a' })], publishedBy: 'pavlo' });
    const v2 = await publishRuleset(repo, CONTEXT, { rules: [ruleBody({ ruleKey: 'b' })], publishedBy: 'pavlo' });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.supersedesVersion).toBe(1);
    expect(v2.digest).not.toBe(v1.digest);
  });
});

describe('publishRuleset — order independence at the storage layer (T018, R-04, quickstart 5)', () => {
  it('publishing the same rules in reverse order evaluates identically across a varied input corpus', async () => {
    const allow: RuleBody = ruleBody({
      ruleKey: 'allow-code-change',
      predicates: [{ kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' }],
      outcome: 'allow',
      reasonCode: 'NO_ADOPTED_EXPECTATION',
    });
    const requireApproval: RuleBody = ruleBody({
      ruleKey: 'require-approval-prod',
      predicates: [{ kind: 'enumerated', field: 'target.environment', operator: 'equals', value: 'production' }],
      outcome: 'require_approval',
      reasonCode: 'APPROVAL_REQUIRED',
    });
    const deny: RuleBody = ruleBody({
      ruleKey: 'deny-over-ceiling',
      predicates: [{ kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 5 }],
      outcome: 'deny',
      reasonCode: 'TARGET_BLOCKED',
    });

    const repoForward = new FakeRulesetRepo();
    const forward = await publishRuleset(repoForward, CONTEXT, {
      rules: [allow, requireApproval, deny],
      publishedBy: 'pavlo',
    });
    const repoReverse = new FakeRulesetRepo();
    const reverse = await publishRuleset(repoReverse, CONTEXT, {
      rules: [deny, requireApproval, allow],
      publishedBy: 'pavlo',
    });

    // Different storage order really did produce different content-addressed versions — this is
    // not a trivial "nothing changed" comparison.
    expect(forward.digest).not.toBe(reverse.digest);

    const forwardRuleset = asResolvedRuleset(forward);
    const reverseRuleset = asResolvedRuleset(reverse);

    const corpus = [
      buildDecisionInput(),
      buildDecisionInput({ action: { actionKey: 'x', actionClass: 'read_only' } }),
      buildDecisionInput({ target: { ...buildDecisionInput().target, environment: 'staging' } }),
      buildDecisionInput({ autonomy: { level: 5 } }),
      buildDecisionInput({ autonomy: { level: 0 } }),
    ];

    for (const input of corpus) {
      const a = evaluate(forwardRuleset, input);
      const b = evaluate(reverseRuleset, input);
      expect(a.decision.outcome).toBe(b.decision.outcome);
      expect([...a.decision.matchedRuleKeys].sort()).toEqual([...b.decision.matchedRuleKeys].sort());
    }
  });
});

describe('publishRuleset — conflict warnings (T020, FR-006, quickstart 6)', () => {
  it('one rule allows, another denies, both match the same input → DENY, and the pair is a conflict warning', async () => {
    const repo = new FakeRulesetRepo();
    const allow = ruleBody({
      ruleKey: 'allow-code-change',
      predicates: [{ kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' }],
      outcome: 'allow',
    });
    const deny = ruleBody({
      ruleKey: 'deny-code-change',
      predicates: [{ kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' }],
      outcome: 'deny',
    });

    const published = await publishRuleset(repo, CONTEXT, { rules: [allow, deny], publishedBy: 'pavlo' });
    expect(published.conflictWarnings).toEqual([
      { ruleKeyA: 'allow-code-change', ruleKeyB: 'deny-code-change' },
    ]);

    const { decision } = evaluate(asResolvedRuleset(published), buildDecisionInput());
    expect(decision.outcome).toBe('deny');
    expect([...decision.matchedRuleKeys].sort()).toEqual(['allow-code-change', 'deny-code-change']);
  });
});
