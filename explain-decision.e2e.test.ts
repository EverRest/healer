import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  evaluateAndBind,
  explainDecision,
  publishRuleset,
  PrismaAutonomyEpochRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
  SEED_POLICY_ACTIONS,
  type DecisionInput,
  type RuleBody,
} from '@healer/domain-policy';
import { TenantContext, withCorrelation } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/** Mirrors `packages/domain/policy/src/domain/test-support/fixtures.ts`'s `buildDecisionInput` —
 *  kept local per this repo's e2e convention (see `policy-decision-repository.e2e.test.ts`'s
 *  identical comment): that file is package-internal test-support, not part of
 *  `@healer/domain-policy`'s public surface. */
function buildDecisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
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

function rule(overrides: Partial<RuleBody> = {}): RuleBody {
  return {
    ruleKey: 'rule',
    predicates: [],
    outcome: 'allow',
    reasonCode: 'NO_ADOPTED_EXPECTATION',
    note: '',
    ...overrides,
  };
}

function componentIs(componentId: string) {
  return [{ kind: 'identifier' as const, field: 'target.componentId' as const, operator: 'equals' as const, value: componentId }];
}

/** Every table in the `policy` schema (data-model.md) — T025's "diff the database before/after,
 *  or count rows in every `policy.*` table" (quickstart 30). */
async function policyRowCounts(prisma: PrismaClient): Promise<Record<string, number>> {
  const [
    policyRuleset,
    policyRule,
    policyAction,
    autonomyGrant,
    autonomyEpoch,
    policyDecision,
    approvalRequest,
    budgetLimit,
    actionLimit,
    budgetDegradationMark,
  ] = await Promise.all([
    prisma.policyRuleset.count(),
    prisma.policyRule.count(),
    prisma.policyAction.count(),
    prisma.autonomyGrant.count(),
    prisma.autonomyEpoch.count(),
    prisma.policyDecision.count(),
    prisma.approvalRequest.count(),
    prisma.budgetLimit.count(),
    prisma.actionLimit.count(),
    prisma.budgetDegradationMark.count(),
  ]);
  return {
    policyRuleset,
    policyRule,
    policyAction,
    autonomyGrant,
    autonomyEpoch,
    policyDecision,
    approvalRequest,
    budgetLimit,
    actionLimit,
    budgetDegradationMark,
  };
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000f8';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

// One rule set covering a representative matrix (T025): a plain allow, a conflict that folds to
// deny, a grant that exceeds the class ceiling, a budget already exhausted, and an action nothing
// matches at all (quickstart 4, 6, 7, 24, 30, 31). Each case gets its own `componentId` so the
// rules stay isolated from one another — this is a matrix over independent cases, not five rules
// meant to interact.
const RULES: RuleBody[] = [
  rule({ ruleKey: 'allow-comp-allow', predicates: componentIs('comp-allow'), outcome: 'allow' }),
  rule({ ruleKey: 'allow-comp-conflict', predicates: componentIs('comp-conflict'), outcome: 'allow' }),
  rule({
    ruleKey: 'deny-comp-conflict',
    predicates: componentIs('comp-conflict'),
    outcome: 'deny',
    reasonCode: 'TARGET_BLOCKED',
  }),
  rule({ ruleKey: 'allow-comp-ceiling', predicates: componentIs('comp-ceiling'), outcome: 'allow' }),
  rule({ ruleKey: 'allow-comp-budget', predicates: componentIs('comp-budget'), outcome: 'allow' }),
];

const MATRIX: { readonly name: string; readonly input: DecisionInput }[] = [
  { name: 'allow', input: buildDecisionInput({ target: { ...buildDecisionInput().target, componentId: 'comp-allow' } }) },
  {
    name: 'conflict resolves to deny (quickstart 6)',
    input: buildDecisionInput({ target: { ...buildDecisionInput().target, componentId: 'comp-conflict' } }),
  },
  {
    name: 'ceiling exceeded (quickstart 7)',
    input: buildDecisionInput({
      target: { ...buildDecisionInput().target, componentId: 'comp-ceiling' },
      autonomy: { level: 3 },
    }),
  },
  {
    name: 'budget exhausted (quickstart 24)',
    input: buildDecisionInput({
      target: { ...buildDecisionInput().target, componentId: 'comp-budget' },
      budget: { consumed: 100, limit: 100, declaredMaxCost: 1, degradationStep: 0 },
    }),
  },
  {
    name: 'no matching rule (quickstart 4)',
    input: buildDecisionInput({ target: { ...buildDecisionInput().target, componentId: 'comp-none' } }),
  },
];

describe('ExplainDecision — dry run writes nothing and matches EvaluateAndBind exactly (002 T024/T025, R-08)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let rulesets: PrismaPolicyRulesetRepository;
  let decisions: PrismaPolicyDecisionRepository;
  let autonomyEpochs: PrismaAutonomyEpochRepository;
  let actions: PrismaPolicyActionRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    rulesets = new PrismaPolicyRulesetRepository(prisma);
    decisions = new PrismaPolicyDecisionRepository(prisma);
    autonomyEpochs = new PrismaAutonomyEpochRepository(prisma);
    actions = new PrismaPolicyActionRepository(prisma);

    // `policy_action` is global (batch 9 C1(b) made `actions` a required dependency of both
    // callers this test compares).
    for (const action of SEED_POLICY_ACTIONS) {
      await prisma.policyAction.create({
        data: { ...action, introducedAt: new Date('2026-01-01T00:00:00Z') },
      });
    }

    await withCorrelation('corr-seed-ruleset', () => publishRuleset(rulesets, CONTEXT, { rules: RULES, publishedBy: 'pavlo' }));
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('runs the whole matrix through ExplainDecision and every policy.* table has the same row count before and after, for every outcome (quickstart 30)', async () => {
    const before = await policyRowCounts(prisma);

    for (const { input } of MATRIX) {
      await withCorrelation('corr-explain', () =>
        explainDecision({ rulesets, actions }, CONTEXT, { decisionInput: input }),
      );
    }

    const after = await policyRowCounts(prisma);
    expect(after).toEqual(before);
  });

  it.each(MATRIX)(
    '$name: ExplainDecision and EvaluateAndBind agree on outcome, matched rules and reason codes (quickstart 31)',
    async ({ input }) => {
      const explained = await withCorrelation('corr-explain-cmp', () =>
        explainDecision({ rulesets, actions }, CONTEXT, { decisionInput: input }),
      );
      const bound = await withCorrelation('corr-bind-cmp', () =>
        evaluateAndBind({ rulesets, decisions, autonomyEpochs, actions }, CONTEXT, { decisionInput: input }),
      );

      expect(explained.decision.outcome).toBe(bound.decision.outcome);
      expect(explained.decision.matchedRuleKeys).toEqual(bound.decision.matchedRuleKeys);
      expect(explained.decision.reasonCodes).toEqual(bound.decision.reasonCodes);
      expect(explained.decision.ceilingApplied).toBe(bound.decision.ceilingApplied);
      expect(explained.decision.rulesetVersion).toBe(bound.decision.rulesetVersion);
    },
  );
});
