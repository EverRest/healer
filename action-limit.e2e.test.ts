import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actionLimitLockKey,
  DEFAULT_REMEDIATION_ACTION_LIMIT,
  explainDecision,
  PrismaActionLimitRepository,
  publishRuleset,
  replayDecision,
  type DecisionInput,
  type RuleBody,
} from '@healer/domain-policy';
import { scope, withCorrelation, type TenantContext } from '@healer/shared';
import { query } from './test/containers.js';
import { decisionInput, hold, seedIssue, seedWorkflowRun } from './test/budget-fixtures.js';
import {
  NOON,
  startBudgetHarness,
  type BudgetHarness,
} from './test/infrastructure/budget-harness.js';

/**
 * 002 T054 / T055 / T085 (FR-014, quickstart 29) against a real Postgres: rate limit, cooldown and
 * attempt cap per `(actionKey, targetRef, fingerprint)`, resolved from `policy_decision` history
 * and `policy.action_limit`, baked into the stored decision_input, serialised by an advisory lock.
 */
const ROLLBACK = {
  action: { actionKey: 'deployment.rollback', actionClass: 'reversible_remediation' },
} as const;
const at = (seconds: number) => new Date(NOON.getTime() + seconds * 1000);

const allowClass = (actionClass: string): RuleBody => ({
  ruleKey: `allow-${actionClass}`,
  predicates: [
    { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: actionClass },
  ],
  outcome: 'allow',
  reasonCode: 'NO_ADOPTED_EXPECTATION',
  note: '',
});

interface Limit {
  rate?: number;
  window?: number;
  cooldown?: number;
  cap?: number;
}

describe('action limits (002 T054, T055, T085)', () => {
  let h: BudgetHarness;
  let limitsRepo: PrismaActionLimitRepository;

  beforeAll(async () => {
    h = await startBudgetHarness();
    limitsRepo = new PrismaActionLimitRepository(h.prisma);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  /** A tenant whose rule set allows remediation and code changes, with an optional limit row. */
  async function tenant(limit?: Limit) {
    const { tenantId, ctx } = await h.newTenant();
    await withCorrelation(randomUUID(), () =>
      publishRuleset(h.rulesets, ctx, {
        rules: [allowClass('reversible_remediation'), allowClass('code_change')],
        publishedBy: 'pavlo',
      }),
    );
    if (limit) await setLimit(tenantId, limit);
    return { tenantId, ctx };
  }

  async function setLimit(tenantId: string, l: Limit): Promise<void> {
    await h.prisma.$executeRaw`
      INSERT INTO "policy"."action_limit"
        (tenant_id, action_key, rate_per_window, window_seconds, cooldown_seconds, attempt_cap,
         updated_at, updated_by)
      VALUES (${tenantId}::uuid, 'deployment.rollback', ${l.rate ?? 999}, ${l.window ?? 3600},
              ${l.cooldown ?? 0}, ${l.cap ?? 999}, now(), 'pavlo')
      ON CONFLICT (tenant_id, action_key) DO UPDATE
        SET rate_per_window = EXCLUDED.rate_per_window, window_seconds = EXCLUDED.window_seconds,
            cooldown_seconds = EXCLUDED.cooldown_seconds, attempt_cap = EXCLUDED.attempt_cap`;
  }

  const propose = (
    ctx: TenantContext,
    seconds: number,
    overrides: Partial<DecisionInput> = {},
    declared = 0,
  ) => h.bind(ctx, declared, {}, at(seconds), { ...ROLLBACK, ...overrides });

  const onTarget = (targetRef: string): Partial<DecisionInput> => ({
    target: { ...decisionInput(0, NOON).target, targetRef },
  });

  /** The stored row, read back — what a replay or an auditor sees. */
  async function stored(ctx: TenantContext, id: string) {
    const row = await h.repos.decisions.findById(scope(ctx, { id }));
    if (row === null) throw new Error('decision not found');
    return row;
  }

  describe('refusal codes (quickstart 29)', () => {
    it('RATE_LIMITED after the rate in the window; the refusal is itself a recorded decision', async () => {
      const { ctx } = await tenant({ rate: 2, window: 3600 });
      expect((await propose(ctx, 0)).decision.outcome).toBe('allow');
      expect((await propose(ctx, 60)).decision.outcome).toBe('allow');

      const refused = (await propose(ctx, 120)).decision;
      expect(refused.outcome).toBe('deny');
      expect(refused.reasonCodes).toContain('RATE_LIMITED');

      const row = await stored(ctx, refused.id);
      expect(row.outcome).toBe('deny');
      expect(row.reasonCodes).toContain('RATE_LIMITED');
      expect(row.decisionInput.cooldown).toMatchObject({
        recentAllowCount: 2,
        windowSeconds: 3600,
        attemptCount: 2,
        secondsSinceLastAllow: 60,
        bounds: { ratePerWindow: 2, cooldownSeconds: 0, attemptCap: 999 },
      });

      // another target is a different scope: unaffected
      expect((await propose(ctx, 120, onTarget('target-2'))).decision.outcome).toBe('allow');
      // the refusal is not itself counted: past the window, the same target is allowed again
      expect((await propose(ctx, 7200)).decision.outcome).toBe('allow');
    });

    it('COOLDOWN until the cooldown has elapsed since the last counted allow', async () => {
      const { ctx } = await tenant({ cooldown: 600 });
      expect((await propose(ctx, 0)).decision.outcome).toBe('allow');
      const refused = (await propose(ctx, 300)).decision;
      expect(refused.reasonCodes).toContain('COOLDOWN');
      expect((await stored(ctx, refused.id)).decisionInput.cooldown).toMatchObject({
        secondsSinceLastAllow: 300,
        bounds: { cooldownSeconds: 600 },
      });
      expect((await propose(ctx, 600)).decision.outcome).toBe('allow'); // exactly elapsed
    });

    it('ATTEMPT_CAP_REACHED after the cap, however old the allows are', async () => {
      const { ctx } = await tenant({ window: 60, cap: 2 });
      expect((await propose(ctx, 0)).decision.outcome).toBe('allow');
      expect((await propose(ctx, 3600)).decision.outcome).toBe('allow');
      const refused = (await propose(ctx, 7200)).decision;
      expect(refused.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
      expect(refused.reasonCodes).not.toContain('RATE_LIMITED'); // both allows are outside the window
      expect((await stored(ctx, refused.id)).decisionInput.cooldown).toMatchObject({
        recentAllowCount: 0,
        attemptCount: 2,
        bounds: { attemptCap: 2 },
      });
    });

    it('a later allow is counted even when the caller passes an earlier instant', async () => {
      const { ctx } = await tenant({ cap: 1 });
      expect((await propose(ctx, 3600)).decision.outcome).toBe('allow');
      const refused = (await propose(ctx, 0)).decision; // a backdated instant must not hide it
      expect(refused.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
      expect((await stored(ctx, refused.id)).decisionInput.cooldown.secondsSinceLastAllow).toBe(0);
    });

    it('a replay of the refused decision is identical, from the stored input alone', async () => {
      const { ctx } = await tenant({ rate: 1 });
      await propose(ctx, 0);
      const refused = await stored(ctx, (await propose(ctx, 60)).decision.id);
      await setLimit(ctx.tenantId, { rate: 999 }); // the row changing later must not matter
      const replay = await replayDecision({ rulesets: h.rulesets }, ctx, refused);
      expect(replay.identical).toBe(true);
      expect(replay.replayed.reasonCodes).toContain('RATE_LIMITED');
    });

    it('the dry run reads the same counts and records nothing', async () => {
      const { tenantId, ctx } = await tenant({ rate: 1 });
      await propose(ctx, 0);
      const before = await countDecisions(tenantId);
      const dry = await explainDecision(
        {
          rulesets: h.rulesets,
          actions: h.repos.actions,
          autonomyGrants: h.repos.autonomyGrants,
          budgets: h.budgets,
          actionLimits: limitsRepo,
        },
        ctx,
        { decisionInput: decisionInput(0, at(60), ROLLBACK) },
      );
      expect(dry.decision.reasonCodes).toContain('RATE_LIMITED');
      expect(await countDecisions(tenantId)).toBe(before);
    });

    it('the charged path applies the same limits', async () => {
      const { ctx } = await tenant({ rate: 1 });
      expect((await propose(ctx, 0, {}, 1)).decision.outcome).toBe('allow');
      expect((await propose(ctx, 60, {}, 1)).decision.reasonCodes).toContain('RATE_LIMITED');
    });
  });

  describe('the anchor instant (review 1)', () => {
    it('a future-dated instant cannot shorten the window or the cooldown', async () => {
      const { ctx } = await tenant({ rate: 1, window: 120, cooldown: 120 });
      const now = new Date();
      expect((await h.bind(ctx, 0, {}, now, ROLLBACK)).decision.outcome).toBe('allow');
      // 4 minutes ahead (inside the skew an enforcing evaluation allows): measured from that
      // instant the allow is 240 s old, outside both the 120 s window and the 120 s cooldown.
      const ahead = new Date(now.getTime() + 240_000);
      const refused = (await h.bind(ctx, 0, {}, ahead, ROLLBACK)).decision;
      expect(refused.reasonCodes).toEqual(expect.arrayContaining(['RATE_LIMITED', 'COOLDOWN']));
    });
  });

  describe('a retried step is idempotent (review 2)', () => {
    async function bound(tenantId: string, state: string) {
      const issueId = await seedIssue(h.pg, tenantId);
      const run = await seedWorkflowRun(h.pg, {
        tenantId,
        issueId,
        startedAt: '2026-10-02T11:00:00Z',
      });
      return { issueId, binding: { workflowRunId: run.id, workflowState: state } };
    }

    it('the same uncharged proposal for the same run and state returns the same decision', async () => {
      const { tenantId, ctx } = await tenant({ rate: 1 });
      const { binding } = await bound(tenantId, 'awaiting_execution');
      const first = (await h.bind(ctx, 0, binding, at(0), ROLLBACK)).decision;
      const retry = (await h.bind(ctx, 0, binding, at(30), ROLLBACK)).decision;
      expect(first.outcome).toBe('allow');
      expect(retry.id).toBe(first.id);
      expect(await countDecisions(tenantId)).toBe(1);
    });

    it('a different workflow state is a new step and is limited', async () => {
      const { tenantId, ctx } = await tenant({ rate: 1 });
      const { binding } = await bound(tenantId, 'awaiting_execution');
      await h.bind(ctx, 0, binding, at(0), ROLLBACK);
      const other = { ...binding, workflowState: 'awaiting_verification' };
      const refused = (await h.bind(ctx, 0, other, at(30), ROLLBACK)).decision;
      expect(refused.reasonCodes).toContain('RATE_LIMITED');
    });

    it('releaseAbandonedCharges leaves an uncharged allow alone', async () => {
      const { tenantId, ctx } = await tenant({ cap: 1 });
      const { binding } = await bound(tenantId, 'awaiting_execution');
      await h.bind(ctx, 0, binding, at(0), ROLLBACK);
      const released = await h.budgets.releaseAbandonedCharges(
        scope(ctx, { olderThan: new Date('2027-01-01T00:00:00Z') }),
      );
      expect(released).toBe(0);
      expect((await propose(ctx, 60)).decision.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
    });
  });

  describe('which allows count', () => {
    it('an abandoned (invalidated, never consumed) allow does not count; a consumed one does', async () => {
      const { tenantId, ctx } = await tenant({ cap: 1 });
      const first = (await propose(ctx, 0)).decision;
      await h.prisma.$executeRaw`
        UPDATE "policy"."policy_decision" SET invalidated_reason = 'charge_abandoned'
        WHERE id = ${first.id}::uuid AND tenant_id = ${tenantId}::uuid`;
      const second = (await propose(ctx, 60)).decision;
      expect(second.outcome).toBe('allow');
      const stateOf = (await stored(ctx, second.id)).decisionInput.cooldown;
      expect(stateOf.attemptCount).toBe(0);

      await withCorrelation(randomUUID(), () =>
        h.repos.decisions.consume(
          scope(ctx, { decisionId: second.id, presentedDigest: second.proposalDigest }),
        ),
      );
      expect((await propose(ctx, 120)).decision.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
    });
  });

  describe('defaults (T054)', () => {
    it('reversible_remediation with no row runs under the product default bounds', async () => {
      const { ctx } = await tenant();
      const { windowSeconds: _w, ...bounds } = DEFAULT_REMEDIATION_ACTION_LIMIT;
      const first = (await propose(ctx, 0)).decision;
      expect(first.outcome).toBe('allow');
      expect((await stored(ctx, first.id)).decisionInput.cooldown.bounds).toEqual(bounds);
      const refused = (await propose(ctx, 60)).decision;
      expect(refused.outcome).toBe('deny');
      expect(refused.reasonCodes).toEqual(expect.arrayContaining(['RATE_LIMITED', 'COOLDOWN']));
    });

    it('any other class with no row is unlimited, and its input carries no bounds', async () => {
      const { ctx } = await tenant();
      for (let i = 0; i < 6; i += 1) {
        const { decision } = await h.bind(ctx, 0, {}, at(i), {});
        expect(decision.outcome).toBe('allow');
        expect((await stored(ctx, decision.id)).decisionInput.cooldown.bounds).toBeUndefined();
      }
    });
  });

  describe('T085 — action_limit is the only source of a refusal', () => {
    it('the same proposals are refused or allowed according to the row alone', async () => {
      const { tenantId, ctx } = await tenant({ cap: 1 });
      expect((await propose(ctx, 0)).decision.outcome).toBe('allow');
      expect((await propose(ctx, 10)).decision.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
      await setLimit(tenantId, { cap: 5 });
      expect((await propose(ctx, 20)).decision.outcome).toBe('allow');
    });
  });

  describe('serialisation (T054 race)', () => {
    const lockKey = (tenantId: string) =>
      actionLimitLockKey(tenantId, 'deployment.rollback', 'target-1', 'fingerprint-1');

    async function waitForLimitWaiters(tenantId: string, wanted: number): Promise<void> {
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

    async function raceUnderHeldLock(declared: number) {
      const { tenantId, ctx } = await tenant({ cap: 1 });
      const holder = await hold(h.prisma, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(tenantId)}, 0))`;
      });
      const pending = [propose(ctx, 0, {}, declared), propose(ctx, 1, {}, declared)];
      // Polls pg_locks for ungranted waiters on the limit key itself — the charged path's second
      // proposal is queued on the budget lock instead, so only the first is ever on this key.
      await waitForLimitWaiters(tenantId, declared > 0 ? 1 : 2);
      await holder.release();
      return Promise.all(pending);
    }

    it.each([
      ['uncharged', 0],
      ['charged', 1],
    ])(
      'two concurrent %s evaluations with attempt_cap 1: exactly one ALLOW',
      async (_name, declared) => {
        const results = (await raceUnderHeldLock(declared)).map((r) => r.decision);
        expect(results.filter((d) => d.outcome === 'allow')).toHaveLength(1);
        const denied = results.filter((d) => d.outcome === 'deny');
        expect(denied).toHaveLength(1);
        expect(denied[0]?.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
      },
    );
  });

  async function countDecisions(tenantId: string): Promise<number> {
    const [row] = await h.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "policy"."policy_decision" WHERE tenant_id = ${tenantId}::uuid`;
    return Number(row?.n);
  }
});
