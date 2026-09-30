import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  consumeDecision,
  DecisionAlreadyConsumedError,
  DigestMismatchError,
  evaluateAndBind,
  PrismaAutonomyEpochRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
  publishRuleset,
  type DecisionInput,
  type RuleBody,
} from '@healer/domain-policy';
import { TenantContext, scope, withCorrelation } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/** A valid, fully-populated `DecisionInput` — mirrors `packages/domain/policy/src/domain/
 *  test-support/fixtures.ts`'s `buildDecisionInput`, kept local rather than imported: that file
 *  is package-internal test-support, not part of `@healer/domain-policy`'s public surface, and
 *  every other e2e test in this repo builds its own row/input helpers rather than reaching into
 *  another package's `src/**` test-support. */
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

/**
 * `PrismaPolicyDecisionRepository` (T021/T022/T023, data-model.md `policy.policy_decision`)
 * against a real Postgres: `evaluateAndBind` persisting a decision plus its `PolicyDecisionRecorded`
 * outbox event in one transaction, and `consumeDecision`'s single-use, digest-bound consumption —
 * consumed twice → `DecisionAlreadyConsumedError` (quickstart 35); a presented digest that does
 * not match the recorded proposal → `DigestMismatchError` (quickstart 36). The atomic
 * `SELECT ... FOR UPDATE` inside `consume()` is what a fake in-memory repository cannot prove —
 * this is why T022 lives here rather than as a unit test.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000f6';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

function allowRule(overrides: Partial<RuleBody> = {}): RuleBody {
  return {
    ruleKey: 'allow-code-change',
    predicates: [
      { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
    ],
    outcome: 'allow',
    reasonCode: 'NO_ADOPTED_EXPECTATION',
    note: '',
    ...overrides,
  };
}

describe('PrismaPolicyDecisionRepository (002 T021/T022/T023)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let rulesets: PrismaPolicyRulesetRepository;
  let decisions: PrismaPolicyDecisionRepository;
  let autonomyEpochs: PrismaAutonomyEpochRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    rulesets = new PrismaPolicyRulesetRepository(prisma);
    decisions = new PrismaPolicyDecisionRepository(prisma);
    autonomyEpochs = new PrismaAutonomyEpochRepository(prisma);

    await withCorrelation('corr-seed-ruleset', () =>
      publishRuleset(rulesets, CONTEXT, { rules: [allowRule()], publishedBy: 'pavlo' }),
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('records a decision bound to a workflow run/state and publishes PolicyDecisionRecorded', async () =>
    withCorrelation('corr-bind-1', async () => {
      const input = buildDecisionInput();
      const { decision } = await evaluateAndBind({ rulesets, decisions, autonomyEpochs }, CONTEXT, {
        decisionInput: input,
        binding: { workflowRunId: randomUUID(), workflowState: 'awaiting_execution' },
      });

      expect(decision.outcome).toBe('allow');
      const row = await prisma.policyDecision.findUnique({ where: { id: decision.id } });
      expect(row).toMatchObject({
        tenantId: TENANT_ID,
        actionKey: 'change.open_pull_request',
        targetRef: 'target-1',
        fingerprint: 'fingerprint-1',
        consumedAt: null,
      });

      const outboxRow = await prisma.outbox.findFirst({
        where: { tenantId: TENANT_ID, name: 'PolicyDecisionRecorded', subjectId: decision.id },
      });
      expect(outboxRow).not.toBeNull();
      expect(outboxRow?.payload).toMatchObject({ outcome: 'allow' });
    }));

  it('an unconsumed decision consumes cleanly once, setting consumed_at', async () =>
    withCorrelation('corr-consume-1', async () => {
      const { decision } = await evaluateAndBind({ rulesets, decisions, autonomyEpochs }, CONTEXT, {
        decisionInput: buildDecisionInput(),
      });

      await consumeDecision(decisions, CONTEXT, {
        decisionId: decision.id,
        presentedDigest: decision.proposalDigest,
      });

      const row = await prisma.policyDecision.findUnique({ where: { id: decision.id } });
      expect(row?.consumedAt).not.toBeNull();
    }));

  it('a second execution against the same decision is DECISION_ALREADY_CONSUMED (quickstart 35)', async () =>
    withCorrelation('corr-consume-2', async () => {
      const { decision } = await evaluateAndBind({ rulesets, decisions, autonomyEpochs }, CONTEXT, {
        decisionInput: buildDecisionInput(),
      });
      await consumeDecision(decisions, CONTEXT, {
        decisionId: decision.id,
        presentedDigest: decision.proposalDigest,
      });

      await expect(
        consumeDecision(decisions, CONTEXT, {
          decisionId: decision.id,
          presentedDigest: decision.proposalDigest,
        }),
      ).rejects.toThrow(DecisionAlreadyConsumedError);
    }));

  it('altering the proposal after evaluation and presenting the new digest is DIGEST_MISMATCH (quickstart 36)', async () =>
    withCorrelation('corr-consume-3', async () => {
      const { decision } = await evaluateAndBind({ rulesets, decisions, autonomyEpochs }, CONTEXT, {
        decisionInput: buildDecisionInput(),
      });

      await expect(
        consumeDecision(decisions, CONTEXT, {
          decisionId: decision.id,
          presentedDigest: 'not-the-real-digest',
        }),
      ).rejects.toThrow(DigestMismatchError);

      // The refused attempt left the decision unconsumed and still valid for its real digest.
      const row = await prisma.policyDecision.findUnique({ where: { id: decision.id } });
      expect(row?.consumedAt).toBeNull();
    }));

  it('concurrent consumption of the same decision: exactly one attempt succeeds, the other sees ALREADY_CONSUMED', async () =>
    withCorrelation('corr-consume-4', async () => {
      const { decision } = await evaluateAndBind({ rulesets, decisions, autonomyEpochs }, CONTEXT, {
        decisionInput: buildDecisionInput(),
      });

      const attempt = () =>
        consumeDecision(decisions, CONTEXT, {
          decisionId: decision.id,
          presentedDigest: decision.proposalDigest,
        });
      const results = await Promise.allSettled([attempt(), attempt()]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        DecisionAlreadyConsumedError,
      );
    }));

  it('a decision id under another tenant is not found, never leaking whether it exists', async () =>
    withCorrelation('corr-consume-5', async () => {
      const { decision } = await evaluateAndBind({ rulesets, decisions, autonomyEpochs }, CONTEXT, {
        decisionInput: buildDecisionInput(),
      });
      const otherTenant = TenantContext.forTrustedInternalUse(
        '00000000-0000-0000-8000-0000000000f7',
      );
      await expect(
        consumeDecision(decisions, otherTenant, {
          decisionId: decision.id,
          presentedDigest: decision.proposalDigest,
        }),
      ).rejects.toThrow(/not found/);
    }));

  describe('findById / list (002 T028, FR-002, FR-017, FR-018)', () => {
    it('findById returns every stored field, including the recorded decisionInput and budgetState', async () =>
      withCorrelation('corr-read-1', async () => {
        const issueId = randomUUID();
        const { decision } = await evaluateAndBind(
          { rulesets, decisions, autonomyEpochs },
          CONTEXT,
          {
            decisionInput: buildDecisionInput(),
            binding: { issueId },
          },
        );

        const found = await decisions.findById(scope(CONTEXT, { id: decision.id }));
        expect(found).toMatchObject({
          id: decision.id,
          actionKey: 'change.open_pull_request',
          targetRef: 'target-1',
          fingerprint: 'fingerprint-1',
          issueId,
          outcome: 'allow',
        });
        expect(found?.decisionInput).toMatchObject({
          action: { actionKey: 'change.open_pull_request' },
        });
        expect(found?.budgetState).toMatchObject({ limit: 100 });
        expect(found?.consumedAt).toBeUndefined();
      }));

    it("findById returns null for another tenant's decision — not found, never a leak (FR-018)", async () =>
      withCorrelation('corr-read-2', async () => {
        const { decision } = await evaluateAndBind(
          { rulesets, decisions, autonomyEpochs },
          CONTEXT,
          {
            decisionInput: buildDecisionInput(),
          },
        );
        const otherTenant = TenantContext.forTrustedInternalUse(
          '00000000-0000-0000-8000-0000000000f7',
        );
        expect(await decisions.findById(scope(otherTenant, { id: decision.id }))).toBeNull();
      }));

    it('findById returns null for a malformed id rather than throwing (SC-004 parity with issues)', async () =>
      withCorrelation('corr-read-3', async () => {
        expect(await decisions.findById(scope(CONTEXT, { id: 'not-a-uuid' }))).toBeNull();
      }));

    it("list narrows by issueId, actionKey, outcome and since, and never returns another tenant's rows", async () =>
      withCorrelation('corr-read-4', async () => {
        const tenant = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000fd');
        const other = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000fe');
        await withCorrelation('corr-read-4-seed-ruleset', () =>
          publishRuleset(rulesets, tenant, { rules: [allowRule()], publishedBy: 'pavlo' }),
        );
        const issueId = randomUUID();
        const { decision: matching } = await evaluateAndBind(
          { rulesets, decisions, autonomyEpochs },
          tenant,
          {
            decisionInput: buildDecisionInput(),
            binding: { issueId },
          },
        );
        await evaluateAndBind({ rulesets, decisions, autonomyEpochs }, tenant, {
          decisionInput: buildDecisionInput({
            target: { ...buildDecisionInput().target, targetRef: 'other-target' },
          }),
        });
        await withCorrelation('corr-read-4-seed-ruleset-other', () =>
          publishRuleset(rulesets, other, { rules: [allowRule()], publishedBy: 'pavlo' }),
        );
        await evaluateAndBind({ rulesets, decisions, autonomyEpochs }, other, {
          decisionInput: buildDecisionInput(),
        });

        const byIssue = await decisions.list(scope(tenant, { issueId }));
        expect(byIssue.map((d) => d.id)).toEqual([matching.id]);

        const byOutcome = await decisions.list(scope(tenant, { outcome: 'allow' }));
        expect(byOutcome.length).toBe(2);
        expect(byOutcome.some((d) => d.id === matching.id)).toBe(true);

        const future = await decisions.list(
          scope(tenant, { since: new Date('2099-01-01T00:00:00Z') }),
        );
        expect(future).toHaveLength(0);
      }));
  });
});
