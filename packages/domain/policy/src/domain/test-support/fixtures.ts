import type { DecisionInput } from '../decision-input.js';

/** A valid, fully-populated `DecisionInput` — every test builds from this via overrides rather
 *  than repeating the whole closed record. Values are arbitrary but internally consistent. */
export function buildDecisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
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
    ...overrides,
  };
}
