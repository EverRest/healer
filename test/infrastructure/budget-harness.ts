import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@healer/prisma-client';
import {
  evaluateAndBind,
  PrismaAutonomyEpochRepository,
  PrismaAutonomyGrantRepository,
  PrismaBudgetLimitRepository,
  PrismaBudgetRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
  publishRuleset,
  putBudgetLimit,
  SEED_POLICY_ACTIONS,
  type EvaluateAndBindRepos,
  type PutBudgetLimitCommand,
  type RuleBody,
} from '@healer/domain-policy';
import { TenantContext, scope, withCorrelation } from '@healer/shared';
import { decisionInput, seedBase, seedTenant } from '../budget-fixtures.js';
import { applySqlFile, startPostgres, type StartedPostgres } from '../containers.js';

// The shared boot of the budget e2e tests (002 Phase 6): a disposable Postgres with every
// migration applied, the real repositories, and the helpers every scenario uses. Not a fake of
// anything — a scenario that needs a different shape plants rows with `budget-fixtures.ts`.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const migrationNames = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

export const NOON = new Date('2026-10-02T12:00:00Z');

const allowCodeChange: RuleBody = {
  ruleKey: 'allow-code-change',
  predicates: [
    { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
  ],
  outcome: 'allow',
  reasonCode: 'NO_ADOPTED_EXPECTATION',
  note: '',
};

export type Binding = { issueId?: string; workflowRunId?: string };

export async function startBudgetHarness() {
  const pg: StartedPostgres = await startPostgres();
  for (const name of migrationNames()) {
    await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
  }
  await seedBase(pg);
  const prisma = new PrismaClient({ datasourceUrl: pg.url });
  const rulesets = new PrismaPolicyRulesetRepository(prisma);
  const budgets = new PrismaBudgetRepository(prisma, {
    maxEvaluationSkewMs: Number.POSITIVE_INFINITY,
  });
  const limits = new PrismaBudgetLimitRepository(prisma);
  const repos: EvaluateAndBindRepos = {
    rulesets,
    decisions: new PrismaPolicyDecisionRepository(prisma),
    autonomyEpochs: new PrismaAutonomyEpochRepository(prisma),
    actions: new PrismaPolicyActionRepository(prisma),
    autonomyGrants: new PrismaAutonomyGrantRepository(prisma),
    budgets,
  };
  for (const action of SEED_POLICY_ACTIONS) {
    await prisma.policyAction.create({
      data: { ...action, introducedAt: new Date('2026-01-01T00:00:00Z') },
    });
  }

  /** A fresh tenant with the allow-everything-code-change rule set published. */
  async function newTenant() {
    const tenantId = randomUUID();
    const ctx = TenantContext.forTrustedInternalUse(tenantId);
    await seedTenant(pg, tenantId);
    await withCorrelation(randomUUID(), () =>
      publishRuleset(rulesets, ctx, { rules: [allowCodeChange], publishedBy: 'pavlo' }),
    );
    return { tenantId, ctx };
  }

  const setLimit = (ctx: TenantContext, overrides: Partial<PutBudgetLimitCommand>) =>
    putBudgetLimit(limits, ctx, {
      scopeType: 'tenant',
      period: 'day',
      spendLimit: 10,
      timeLimitMs: overrides.scopeType === 'issue' ? 3_600_000 : 86_400_000, // each within its bound
      softThresholdPcts: [50, 75, 90],
      escalationAttemptCap: 2,
      updatedBy: 'pavlo',
      ...overrides,
    });

  const bind = (ctx: TenantContext, declared: number, binding: Binding = {}, at: Date = NOON) =>
    withCorrelation(randomUUID(), () =>
      evaluateAndBind(repos, ctx, { decisionInput: decisionInput(declared, at), binding }),
    );

  const resolve = (ctx: TenantContext, q: Binding = {}, at = NOON) =>
    budgets.resolve(scope(ctx, { ...q, asOf: at }));

  const tenantDay = (b: Awaited<ReturnType<typeof resolve>>) =>
    b.scopes.find((s) => s.scopeType === 'tenant' && s.period === 'day')!;

  return {
    pg,
    prisma,
    repos,
    budgets,
    limits,
    rulesets,
    newTenant,
    setLimit,
    bind,
    resolve,
    tenantDay,
    stop: async () => {
      await prisma.$disconnect();
      await pg.stop();
    },
  };
}

export type BudgetHarness = Awaited<ReturnType<typeof startBudgetHarness>>;
