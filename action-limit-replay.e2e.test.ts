import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actionLimitLockKey,
  publishRuleset,
  type DecisionInput,
  type RuleBody,
} from '@healer/domain-policy';
import { withCorrelation, type TenantContext } from '@healer/shared';
import { query } from './test/containers.js';
import { hold, seedIssue, seedWorkflowRun } from './test/budget-fixtures.js';
import {
  NOON,
  startBudgetHarness,
  type BudgetHarness,
} from './test/infrastructure/budget-harness.js';

/**
 * 002 T054 (FR-014) against a real Postgres: a retried step is re-evaluated, never answered from
 * its earlier allow. The earlier live allow comes back only if the fresh decision also allows, and
 * the fresh counts leave that allow out so a retry never counts or refuses itself.
 */
const ROLLBACK = {
  action: { actionKey: 'deployment.rollback', actionClass: 'reversible_remediation' },
} as const;
const CODE_CHANGE = {
  action: { actionKey: 'change.open_pull_request', actionClass: 'code_change' },
} as const;
const at = (seconds: number) => new Date(NOON.getTime() + seconds * 1000);

const allowClass = (actionClass: string, minLevel: number): RuleBody => ({
  ruleKey: `allow-${actionClass}`,
  predicates: [
    {
      kind: 'enumerated',
      field: 'action.actionClass',
      operator: 'equals',
      value: actionClass,
    },
    { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: minLevel },
  ],
  outcome: 'allow',
  reasonCode: 'NO_ADOPTED_EXPECTATION',
  note: '',
});

// `declared` 0 is the uncharged path, 1 the charged one (budget lock, then limit lock).
const PATHS = [
  ['uncharged', 0],
  ['charged', 1],
] as const;

describe('a replayed step is re-evaluated (002 T054)', () => {
  let h: BudgetHarness;

  beforeAll(async () => {
    h = await startBudgetHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function tenant(minLevel = 0, cap = 999) {
    const { tenantId, ctx } = await h.newTenant();
    await withCorrelation(randomUUID(), () =>
      publishRuleset(h.rulesets, ctx, {
        rules: [allowClass('reversible_remediation', 0), allowClass('code_change', minLevel)],
        publishedBy: 'pavlo',
      }),
    );
    await setCap(tenantId, cap);
    const issueId = await seedIssue(h.pg, tenantId);
    const run = await seedWorkflowRun(h.pg, {
      tenantId,
      issueId,
      startedAt: '2026-10-02T11:00:00Z',
    });
    return {
      tenantId,
      ctx,
      binding: { workflowRunId: run.id, workflowState: 'awaiting_execution' },
    };
  }

  async function setCap(tenantId: string, cap: number): Promise<void> {
    await h.prisma.$executeRaw`
      INSERT INTO "policy"."action_limit"
        (tenant_id, action_key, rate_per_window, window_seconds, cooldown_seconds, attempt_cap,
         updated_at, updated_by)
      VALUES (${tenantId}::uuid, 'deployment.rollback', 999, 3600, 0, ${cap}, now(), 'pavlo')
      ON CONFLICT (tenant_id, action_key) DO UPDATE SET attempt_cap = EXCLUDED.attempt_cap`;
  }

  const step = (
    ctx: TenantContext,
    binding: { workflowRunId: string; workflowState: string },
    declared: number,
    seconds: number,
    overrides: Partial<DecisionInput> = {},
  ) => h.bind(ctx, declared, binding, at(seconds), { ...ROLLBACK, ...overrides });

  const otherStep: Partial<DecisionInput> = {
    issue: { state: 'diagnosed', classification: 'out_of_memory' },
  };

  async function liveAllows(tenantId: string): Promise<number> {
    const [row] = await h.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "policy"."policy_decision"
      WHERE tenant_id = ${tenantId}::uuid AND outcome = 'allow' AND invalidated_reason IS NULL`;
    return Number(row?.n);
  }

  describe.each(PATHS)('%s', (_path, declared) => {
    it('an allow, then the autonomy grant is revoked: the retry is refused, not the old allow', async () => {
      const { tenantId, ctx, binding } = await tenant(1);
      await h.prisma.$executeRaw`
        INSERT INTO "policy"."autonomy_grant" (id, tenant_id, action_key, level, granted_by, granted_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, 'change.open_pull_request', 1, 'pavlo', now())`;
      const first = (await step(ctx, binding, declared, 0, CODE_CHANGE)).decision;
      expect(first.outcome).toBe('allow');

      await h.prisma.$executeRaw`
        UPDATE "policy"."autonomy_grant" SET revoked_by = 'pavlo', revoked_at = now()
        WHERE tenant_id = ${tenantId}::uuid`;
      const retry = (await step(ctx, binding, declared, 30, CODE_CHANGE)).decision;

      expect(retry.outcome).not.toBe('allow');
      expect(retry.id).not.toBe(first.id);
    });

    it('an allow, nothing changes: the same decision comes back and a cap of 1 does not refuse it', async () => {
      const { tenantId, ctx, binding } = await tenant(0, 1);
      const first = (await step(ctx, binding, declared, 0)).decision;
      const retry = (await step(ctx, binding, declared, 30)).decision;
      expect(first.outcome).toBe('allow');
      expect(retry.id).toBe(first.id);
      expect(await liveAllows(tenantId)).toBe(1);
    });

    it('a different step for the same action and target still counts: ATTEMPT_CAP_REACHED', async () => {
      const { ctx, binding } = await tenant(0, 1);
      expect((await step(ctx, binding, declared, 0)).decision.outcome).toBe('allow');
      const other = (await step(ctx, binding, declared, 30, otherStep)).decision;
      expect(other.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
    });

    it('an allow, then the cap is tightened below the other attempts: the retry is refused', async () => {
      const { tenantId, ctx, binding } = await tenant(0, 999);
      expect((await step(ctx, binding, declared, 0)).decision.outcome).toBe('allow');
      const second = (await step(ctx, binding, declared, 10, otherStep)).decision;
      expect(second.outcome).toBe('allow');

      await setCap(tenantId, 1);
      const retry = (await step(ctx, binding, declared, 30, otherStep)).decision;

      expect(retry.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
      expect(retry.id).not.toBe(second.id);
    });
  });

  it('a charged retry does not count its own reservation against the budget', async () => {
    const { ctx, binding } = await tenant();
    await h.setLimit(ctx, { spendLimit: 1 });
    const first = (await step(ctx, binding, 1, 0)).decision;
    const retry = (await step(ctx, binding, 1, 30)).decision;
    expect(first.outcome).toBe('allow');
    expect(retry.id).toBe(first.id);
  });

  describe('a row that is not this step still counts (NULL run, state or key)', () => {
    it.each(PATHS)(
      '%s: an unbound allow of the same proposal counts toward the cap',
      async (_p, declared) => {
        const { ctx, binding } = await tenant(0, 1);
        expect((await h.bind(ctx, declared, {}, at(0), ROLLBACK)).decision.outcome).toBe('allow');
        const bound = (await step(ctx, binding, declared, 30)).decision;
        expect(bound.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
      },
    );

    it.each(PATHS)(
      '%s: an allow bound to a run only counts toward the cap',
      async (_p, declared) => {
        const { ctx, binding } = await tenant(0, 1);
        const runOnly = { workflowRunId: binding.workflowRunId };
        expect((await h.bind(ctx, declared, runOnly, at(0), ROLLBACK)).decision.outcome).toBe(
          'allow',
        );
        const bound = (await step(ctx, binding, declared, 30)).decision;
        expect(bound.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
      },
    );

    it("a legacy allow with no request key counts toward another step's cap", async () => {
      const { tenantId, ctx, binding } = await tenant(0, 1);
      const first = (await step(ctx, binding, 0, 0)).decision;
      await h.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw`
          UPDATE "policy"."policy_decision" SET request_key = NULL
          WHERE tenant_id = ${tenantId}::uuid AND id = ${first.id}::uuid`;
      });
      const bound = (await step(ctx, binding, 0, 30)).decision;
      expect(bound.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
    });

    it('an unbound open charge counts against the budget of a bound step', async () => {
      const { ctx, binding } = await tenant();
      await h.setLimit(ctx, { spendLimit: 1 });
      expect((await h.bind(ctx, 1, {}, at(0), ROLLBACK)).decision.outcome).toBe('allow');
      const bound = (await step(ctx, binding, 1, 30)).decision;
      expect(bound.reasonCodes).toContain('BUDGET_EXHAUSTED');
    });
  });

  describe('two simultaneous identical retries', () => {
    const lockKey = (tenantId: string) =>
      actionLimitLockKey(tenantId, 'deployment.rollback', 'target-1', 'fingerprint-1');

    async function waitForWaiters(tenantId: string, wanted: number): Promise<void> {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const waiting = Number(
          await query(
            h.pg,
            `select count(*) from pg_locks where locktype = 'advisory' and not granted
               and ((classid::bigint << 32) | objid::bigint) =
                   hashtextextended('${lockKey(tenantId)}', 0)`,
          ),
        );
        if (waiting >= wanted) return;
        if (Date.now() > deadline)
          throw new Error(`expected ${wanted} waiter(s) on the limit lock`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    it.each(PATHS)('%s: exactly one live allow row exists afterwards', async (_path, declared) => {
      const { tenantId, ctx, binding } = await tenant();
      const holder = await hold(h.prisma, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(tenantId)}, 0))`;
      });
      const pending = [step(ctx, binding, declared, 0), step(ctx, binding, declared, 1)];
      // The charged path's second call queues on the budget lock, so only one is on this key.
      await waitForWaiters(tenantId, declared > 0 ? 1 : 2);
      await holder.release();
      const [a, b] = (await Promise.all(pending)).map((r) => r.decision);

      expect(a?.id).toBe(b?.id);
      expect(await liveAllows(tenantId)).toBe(1);
    });
  });
});
