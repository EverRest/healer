import { describe, expect, it } from 'vitest';
import { replayOne } from './decision-replay.mjs';

const RULESET = {
  version: 1,
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
    },
  ],
};

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

describe('replayOne (002 T030, FR-002, SC-002)', () => {
  it('returns null when the replayed outcome agrees with the recorded one', () => {
    const row = { id: 'd1', decisionInput: DECISION_INPUT, rulesetVersion: 1, outcome: 'allow' };
    expect(replayOne(row, RULESET)).toBeNull();
  });

  it('flags a decision whose replay disagrees with its recorded outcome', () => {
    const row = { id: 'd2', decisionInput: DECISION_INPUT, rulesetVersion: 1, outcome: 'deny' };
    expect(replayOne(row, RULESET)).toBe(
      'decision d2: recorded outcome "deny", replay against ruleset version 1 produced "allow"',
    );
  });

  it('flags a decision whose cited ruleset version no longer resolves (SC-003 violation)', () => {
    const row = { id: 'd3', decisionInput: DECISION_INPUT, rulesetVersion: 9, outcome: 'allow' };
    expect(replayOne(row, null)).toBe(
      'decision d3: ruleset version 9 no longer resolves for its tenant (violates SC-003)',
    );
  });
});
