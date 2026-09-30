import { describe, expect, it } from 'vitest';
import type { PublishedRuleset, ReadOnlyPolicyRulesetRepository } from '@healer/domain-policy';
import { replayOne } from './decision-replay.mjs';

const RULESET: PublishedRuleset = {
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
};

/** `replayOne` now goes through the shared `replayDecision` query (batch 9 C2, review finding),
 *  so this fake is a `ReadOnlyPolicyRulesetRepository`, not a plain `{version, rules}` object. */
class FakeRulesetRepo implements ReadOnlyPolicyRulesetRepository {
  constructor(private readonly ruleset: PublishedRuleset | null) {}
  async findByDigest(): Promise<PublishedRuleset | null> {
    return this.ruleset;
  }
  async findLatest(): Promise<PublishedRuleset | null> {
    return this.ruleset;
  }
  async findByVersion(): Promise<PublishedRuleset | null> {
    return this.ruleset;
  }
  async list(): Promise<readonly PublishedRuleset[]> {
    return this.ruleset === null ? [] : [this.ruleset];
  }
}

const DECISION_INPUT = {
  action: { actionKey: 'change.open_pull_request', actionClass: 'code_change' },
  target: {
    componentId: 'component-1',
    environment: 'production',
    issueKind: 'production_incident',
    targetRef: 'target-1',
    fingerprint: 'fingerprint-1',
  },
  issue: { state: 'diagnosed', classification: 'null_pointer' },
  eligibility: { codeProblemVerdict: 'code_problem', fixEligible: true },
  evidence: { complete: true, conclusionHasLink: true },
  reproduction: { outcome: 'pass' },
  impact: {
    classification: 'localized',
    touchesPublicContract: false,
    touchesMigration: false,
    touchesAuthPath: false,
    touchesMoneyPath: false,
    closure: { memberIds: ['component-1'], maxDepth: 1 },
  },
  reversibility: { reversible: true, hasTestedUndo: true },
  autonomy: { level: 2 },
  budget: { consumed: 0, limit: 100, declaredMaxCost: 1, degradationStep: 0 },
  cooldown: { recentAllowCount: 0, windowSeconds: 3600, attemptCount: 0 },
  escalation: { attemptCount: 0 },
  evaluatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const ROW_BASE = {
  id: 'd1',
  tenantId: '00000000-0000-0000-8000-0000000000e9',
  decisionInput: DECISION_INPUT,
  rulesetVersion: 1,
  outcome: 'allow',
  matchedRuleKeys: ['allow-code-change'],
};

describe('replayOne (002 T030, FR-002, SC-002; batch 9 C2)', () => {
  it('returns null when the replayed outcome and matched rule keys agree with the recorded ones', async () => {
    expect(await replayOne(new FakeRulesetRepo(RULESET), ROW_BASE)).toBeNull();
  });

  it('flags a decision whose replay disagrees with its recorded outcome', async () => {
    const row = { ...ROW_BASE, id: 'd2', outcome: 'deny' };
    expect(await replayOne(new FakeRulesetRepo(RULESET), row)).toBe(
      'decision d2: recorded outcome "deny", replay against ruleset version 1 produced "allow"',
    );
  });

  it('flags a decision whose recorded matched rule keys disagree even though the outcome agrees (data-model.md Invariants: outcome AND matched_rule_keys)', async () => {
    const row = { ...ROW_BASE, id: 'd4', matchedRuleKeys: ['some-other-rule'] };
    const violation = await replayOne(new FakeRulesetRepo(RULESET), row);
    expect(violation).toContain('recorded matched rule keys ["some-other-rule"]');
    expect(violation).toContain('produced ["allow-code-change"]');
  });

  it('flags a decision whose cited ruleset version no longer resolves (SC-003 violation)', async () => {
    const row = { ...ROW_BASE, id: 'd3', rulesetVersion: 9 };
    expect(await replayOne(new FakeRulesetRepo(null), row)).toBe(
      'decision d3: ruleset version 9 no longer resolves for its tenant (violates SC-003)',
    );
  });

  it('replays a decision_input whose evaluatedAt round-tripped through JSONB as a string, instead of throwing (batch 9 C2 reproduction)', async () => {
    const instantRuleset: PublishedRuleset = {
      ...RULESET,
      rules: [
        {
          ruleKey: 'deny-before-2027',
          predicates: [
            { kind: 'instant', field: 'evaluatedAt', operator: 'before', value: '2027-01-01T00:00:00.000Z' },
          ],
          outcome: 'deny',
          reasonCode: 'TARGET_BLOCKED',
          note: '',
        },
      ],
    };
    // `JSON.parse(JSON.stringify(...))` turns `evaluatedAt` into a plain string — exactly what a
    // real JSONB column hands back, and what used to make `matchesInstant`'s `.getTime()` throw.
    const jsonRoundTripped = JSON.parse(JSON.stringify(DECISION_INPUT));
    const row = {
      ...ROW_BASE,
      id: 'd5',
      decisionInput: jsonRoundTripped,
      outcome: 'deny',
      matchedRuleKeys: ['deny-before-2027'],
    };
    await expect(replayOne(new FakeRulesetRepo(instantRuleset), row)).resolves.toBeNull();
  });
});
