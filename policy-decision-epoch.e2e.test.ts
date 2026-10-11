import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consumeDecision,
  DecisionAlreadyConsumedError,
  DecisionNotAllowedError,
  PrismaAutonomyGrantRepository,
  publishRuleset,
  revokeAutonomy,
  type DecisionInput,
  type RuleBody,
} from '@healer/domain-policy';
import { NotFoundError, TenantContext, withCorrelation } from '@healer/shared';
import { hold, seedIssue, seedWorkflowRun, waitForBlocked } from './test/budget-fixtures.js';
import {
  NOON,
  startBudgetHarness,
  type BudgetHarness,
} from './test/infrastructure/budget-harness.js';

/**
 * 002 (R-13): a policy decision is bound to the autonomy epoch it was evaluated under, and
 * `consume` refuses one that is NULL or older than the tenant's current epoch. Real Postgres;
 * the revocation goes through the real `RevokeAutonomy` command.
 */
const at = (seconds: number) => new Date(NOON.getTime() + seconds * 1000);
const CODE_CHANGE = {
  action: { actionKey: 'change.open_pull_request', actionClass: 'code_change' },
} as const;

const allowFromLevel = (minLevel: number): RuleBody => ({
  ruleKey: 'allow-code-change',
  predicates: [
    { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
    { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: minLevel },
  ],
  outcome: 'allow',
  reasonCode: 'NO_ADOPTED_EXPECTATION',
  note: '',
});

describe('a decision is bound to its autonomy epoch (002 R-13)', () => {
  let h: BudgetHarness;

  beforeAll(async () => {
    h = await startBudgetHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  /** A tenant whose allow rule needs level >= minLevel, with one live grant giving level 1. */
  async function tenant(minLevel = 0) {
    const { tenantId, ctx } = await h.newTenant();
    await withCorrelation(randomUUID(), () =>
      publishRuleset(h.rulesets, ctx, { rules: [allowFromLevel(minLevel)], publishedBy: 'pavlo' }),
    );
    const grantId = randomUUID();
    await h.prisma.$executeRaw`
      INSERT INTO "policy"."autonomy_grant" (id, tenant_id, action_key, level, granted_by, granted_at)
      VALUES (${grantId}::uuid, ${tenantId}::uuid, 'change.open_pull_request', 1, 'pavlo', now())`;
    const issueId = await seedIssue(h.pg, tenantId);
    const run = await seedWorkflowRun(h.pg, {
      tenantId,
      issueId,
      startedAt: '2026-10-02T11:00:00Z',
    });
    const binding = { workflowRunId: run.id, workflowState: 'awaiting_execution' };
    return { tenantId, ctx, grantId, binding };
  }

  const revoke = (ctx: TenantContext, grantId: string) =>
    withCorrelation(randomUUID(), () =>
      revokeAutonomy({ grants: new PrismaAutonomyGrantRepository(h.prisma) }, ctx, {
        grantId,
        revokedBy: 'pavlo',
      }),
    );

  const bump = (ctx: TenantContext) =>
    h.repos.autonomyEpochs.bump({ tenantId: ctx.tenantId, bumpedBy: 'pavlo', bumpReason: 'test' });

  const step = (
    ctx: TenantContext,
    binding: { workflowRunId: string; workflowState: string },
    seconds: number,
    overrides: Partial<DecisionInput> = {},
  ) => h.bind(ctx, 0, binding, at(seconds), { ...CODE_CHANGE, ...overrides });

  const consume = (ctx: TenantContext, id: string, digest: string) =>
    consumeDecision(h.repos.decisions, ctx, { decisionId: id, presentedDigest: digest });

  const row = async (tenantId: string, id: string) =>
    (
      await h.prisma.$queryRaw<
        {
          autonomy_epoch: bigint | null;
          invalidated_reason: string | null;
          consumed_at: Date | null;
        }[]
      >`SELECT autonomy_epoch, invalidated_reason, consumed_at FROM "policy"."policy_decision"
        WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`
    )[0]!;

  async function liveAllows(tenantId: string): Promise<number> {
    const [r] = await h.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "policy"."policy_decision"
      WHERE tenant_id = ${tenantId}::uuid AND outcome = 'allow' AND invalidated_reason IS NULL`;
    return Number(r?.n);
  }

  it('records the epoch the evaluation read', async () => {
    const { tenantId, ctx, binding } = await tenant();
    await bump(ctx);
    const { decision, autonomyEpoch } = await step(ctx, binding, 0);
    expect(autonomyEpoch).toBe(1n);
    expect((await row(tenantId, decision.id)).autonomy_epoch).toBe(1n);
  });

  it('(a) an allow, then a revocation: consume refuses it as stale', async () => {
    const { tenantId, ctx, grantId, binding } = await tenant();
    const { decision } = await step(ctx, binding, 0);
    expect(decision.outcome).toBe('allow');

    await revoke(ctx, grantId);

    const refused = await consume(ctx, decision.id, decision.proposalDigest).catch((e) => e);
    expect(refused).toBeInstanceOf(DecisionNotAllowedError);
    expect(refused.reason).toBe('epoch_stale');
    expect((await row(tenantId, decision.id)).consumed_at).toBeNull();
  });

  it('(b) an allow, no epoch change: consume succeeds', async () => {
    const { tenantId, ctx, binding } = await tenant();
    await bump(ctx); // a non-zero epoch that has not moved since the evaluation
    const { decision } = await step(ctx, binding, 0);
    await consume(ctx, decision.id, decision.proposalDigest);
    expect((await row(tenantId, decision.id)).consumed_at).not.toBeNull();
  });

  it('(c) a legacy allow with a NULL epoch is refused at consume', async () => {
    const { tenantId, ctx, binding } = await tenant();
    const { decision } = await step(ctx, binding, 0);
    await h.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`
        UPDATE "policy"."policy_decision" SET autonomy_epoch = NULL
        WHERE tenant_id = ${tenantId}::uuid AND id = ${decision.id}::uuid`;
    });
    const refused = await consume(ctx, decision.id, decision.proposalDigest).catch((e) => e);
    expect(refused).toBeInstanceOf(DecisionNotAllowedError);
    expect(refused.reason).toBe('epoch_stale');
  });

  it('(d) a replay after an epoch bump that still allows: a new allow, the old one invalidated', async () => {
    const { tenantId, ctx, binding } = await tenant();
    const first = (await step(ctx, binding, 0)).decision;
    await bump(ctx);

    const retry = (await step(ctx, binding, 30)).decision;

    expect(retry.outcome).toBe('allow');
    expect(retry.id).not.toBe(first.id);
    expect((await row(tenantId, first.id)).invalidated_reason).toBe('epoch_bump');
    expect((await row(tenantId, retry.id)).autonomy_epoch).toBe(1n);
    expect(await liveAllows(tenantId)).toBe(1);
    await consume(ctx, retry.id, retry.proposalDigest);
  });

  it('(d2) a replay of a step whose allow was already consumed: that allow comes back, no second allow', async () => {
    const { tenantId, ctx, binding } = await tenant();
    const first = (await step(ctx, binding, 0)).decision;
    await consume(ctx, first.id, first.proposalDigest);
    await bump(ctx);

    const retry = (await step(ctx, binding, 30)).decision;

    expect(retry.id).toBe(first.id);
    expect(await liveAllows(tenantId)).toBe(1);
  });

  it('(e) a replay after a revocation that now refuses: refusal recorded, old allow invalidated', async () => {
    const { tenantId, ctx, grantId, binding } = await tenant(1);
    const first = (await step(ctx, binding, 0)).decision;
    expect(first.outcome).toBe('allow');

    await revoke(ctx, grantId);
    const retry = (await step(ctx, binding, 30)).decision;

    expect(retry.outcome).not.toBe('allow');
    expect(retry.id).not.toBe(first.id);
    expect((await row(tenantId, first.id)).invalidated_reason).toBe('epoch_bump');
    expect(await liveAllows(tenantId)).toBe(0);
    const refused = await consume(ctx, first.id, first.proposalDigest).catch((e) => e);
    expect(refused).toBeInstanceOf(DecisionNotAllowedError);
    expect(refused.reason).toBe('invalidated');
  });

  it('(f) another tenant is never read: its epoch does not stale this allow, its id is not found', async () => {
    const a = await tenant();
    const b = await tenant();
    const { decision } = await step(a.ctx, a.binding, 0);
    await bump(b.ctx);
    await bump(b.ctx);

    await expect(consume(b.ctx, decision.id, decision.proposalDigest)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await consume(a.ctx, decision.id, decision.proposalDigest);
    expect((await row(a.tenantId, decision.id)).consumed_at).not.toBeNull();
  });

  it('(g) two concurrent consumes of one decision: exactly one wins', async () => {
    const { tenantId, ctx, binding } = await tenant();
    const { decision } = await step(ctx, binding, 0);
    const holder = await hold(h.prisma, async (tx) => {
      await tx.$executeRaw`
        SELECT 1 FROM "policy"."policy_decision"
        WHERE tenant_id = ${tenantId}::uuid AND id = ${decision.id}::uuid FOR UPDATE`;
    });
    const pending = [
      consume(ctx, decision.id, decision.proposalDigest),
      consume(ctx, decision.id, decision.proposalDigest),
    ].map((p) =>
      p.then(
        () => 'won',
        (e: unknown) => e,
      ),
    );
    await waitForBlocked(h.pg, 2, holder);
    await holder.release();

    const results = await Promise.all(pending);
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(results.filter((r) => r instanceof DecisionAlreadyConsumedError)).toHaveLength(1);
  });
});
