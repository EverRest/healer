import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateAndBind,
  publishRuleset,
  PrismaAutonomyEpochRepository,
  PrismaAutonomyGrantRepository,
  PrismaBudgetRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
  SEED_POLICY_ACTIONS,
  type DecisionInput,
} from '@healer/domain-policy';
import { TenantContext, newCorrelationId, withCorrelation } from '@healer/shared';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { findReplayMismatches } from './decision-replay.mjs';

/**
 * `check:decision-replay`'s real, live-database query (002 T030, FR-002, SC-002), proven against a
 * real Postgres: a decision recorded against a published rule set replays clean, and a decision
 * whose `decision_input` was hand-mutated after the fact (the only way to produce a real mismatch
 * without corrupting the append-only trigger's own guarantee) is flagged.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000e5';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

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

describe('check:decision-replay against a real Postgres (002 T030, FR-002, SC-002)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });

    const rulesets = new PrismaPolicyRulesetRepository(prisma);
    const decisions = new PrismaPolicyDecisionRepository(prisma);
    const autonomyEpochs = new PrismaAutonomyEpochRepository(prisma);
    const autonomyGrants = new PrismaAutonomyGrantRepository(prisma);
    const budgets = new PrismaBudgetRepository(prisma, {
      maxEvaluationSkewMs: Number.POSITIVE_INFINITY,
    });
    const actions = new PrismaPolicyActionRepository(prisma);
    for (const action of SEED_POLICY_ACTIONS) {
      await prisma.policyAction.create({
        data: { ...action, introducedAt: new Date('2026-01-01T00:00:00Z') },
      });
    }

    await withCorrelation(newCorrelationId(), async () => {
      await publishRuleset(rulesets, CONTEXT, {
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
        publishedBy: 'pavlo',
      });
      await evaluateAndBind(
        { rulesets, decisions, autonomyEpochs, actions, autonomyGrants, budgets },
        CONTEXT,
        {
          decisionInput: buildDecisionInput(),
        },
      );
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('replays clean against real, untouched history', async () => {
    expect(await findReplayMismatches(prisma)).toEqual([]);
  });

  it('binds a decision to its own recorded version, not a since-published superseding one with different rules', async () => {
    // A separate tenant so this is unaffected by the other tests' in-place mutation of every
    // policy_decision row under TENANT_ID.
    const tenant = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000e6');
    const rulesets = new PrismaPolicyRulesetRepository(prisma);
    const decisions = new PrismaPolicyDecisionRepository(prisma);
    const autonomyEpochs = new PrismaAutonomyEpochRepository(prisma);
    const autonomyGrants = new PrismaAutonomyGrantRepository(prisma);
    const budgets = new PrismaBudgetRepository(prisma, {
      maxEvaluationSkewMs: Number.POSITIVE_INFINITY,
    });
    const actions = new PrismaPolicyActionRepository(prisma);

    await withCorrelation(newCorrelationId(), async () => {
      await publishRuleset(rulesets, tenant, {
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
        publishedBy: 'pavlo',
      });
      const { decision } = await evaluateAndBind(
        { rulesets, decisions, autonomyEpochs, actions, autonomyGrants, budgets },
        tenant,
        {
          decisionInput: buildDecisionInput(),
        },
      );
      expect(decision.outcome).toBe('allow');
      expect(decision.rulesetVersion).toBe(1);

      // A materially different v2 for the same tenant: what v1 said ALLOW, v2 says DENY. If the
      // check ever resolved "latest" instead of the decision's own recorded ruleset_version, this
      // would flip the replay to "deny" and falsely flag the v1 decision as a mismatch.
      await publishRuleset(rulesets, tenant, {
        rules: [
          {
            ruleKey: 'deny-code-change',
            predicates: [
              {
                kind: 'enumerated',
                field: 'action.actionClass',
                operator: 'equals',
                value: 'code_change',
              },
            ],
            outcome: 'deny',
            reasonCode: 'NO_ADOPTED_EXPECTATION',
            note: '',
          },
        ],
        publishedBy: 'pavlo',
      });

      const violations = await findReplayMismatches(prisma);
      expect(violations.filter((v) => v.includes(decision.id))).toEqual([]);
    });
  });

  it('flags a decision whose recorded outcome no longer matches a fresh replay', async () => {
    // The only honest way to produce a real mismatch without defeating the append-only trigger
    // this row is protected by (`policy_decision_append_only`) is a privileged write — same
    // mechanism `prisma-issue-deletion.ts` already relies on for its own nulling statement.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('healer.privileged_write', 'on', true)`;
      await tx.$executeRaw`
        UPDATE "policy"."policy_decision" SET outcome = 'deny' WHERE tenant_id = ${TENANT_ID}::uuid`;
    });

    const violations = await findReplayMismatches(prisma);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/recorded outcome "deny", replay .* produced "allow"/);
  });
});
