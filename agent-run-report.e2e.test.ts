import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentRunReferenceNotFoundError,
  AgentRunReportConflictError,
  PrismaAgentRunRepository,
  recordAgentRunReport,
  type RecordAgentRunReportInput,
} from '@healer/domain-policy';
import { NotFoundError } from '@healer/shared';
import { query } from './test/containers.js';
import { hold, seedIssue, seededPromptVersionId, waitForBlocked } from './test/budget-fixtures.js';
import { startBudgetHarness, type BudgetHarness } from './test/infrastructure/budget-harness.js';

/**
 * `agent_run` from a runner's report (012 T094, FR-033, FR-046a), against a real Postgres: the row
 * is attributed to a runner of the authenticated tenant, the cost is recorded as reported with
 * provenance, a redelivery charges nothing twice, and the unsafe states are refused by the
 * database itself rather than by a caller remembering to check.
 */
describe('recordAgentRunReport (012 T094)', () => {
  let h: BudgetHarness;
  let repo: PrismaAgentRunRepository;

  beforeAll(async () => {
    h = await startBudgetHarness();
    repo = new PrismaAgentRunRepository(h.prisma);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function runnerOf(tenantId: string, name = 'runner-1'): Promise<string> {
    const id = randomUUID();
    await h.prisma.runnerRegistration.create({
      data: {
        id,
        tenantId,
        name,
        protocolVersion: 1,
        capabilities: [],
        imageVersion: '1.0.0',
        status: 'active',
        lastHeartbeatAt: new Date(),
      },
    });
    return id;
  }

  const report = (
    overrides: Partial<RecordAgentRunReportInput> = {},
  ): RecordAgentRunReportInput => ({
    reportId: randomUUID(),
    runnerName: 'runner-1',
    correlationId: randomUUID(),
    agentKind: 'change',
    modelId: 'claude-sonnet-5',
    provider: 'anthropic',
    promptVersionId: seededPromptVersionId(),
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.1 + 0.2,
    toolCalls: [{ name: 'read_file', argumentDigest: 'a'.repeat(64), outcome: 'ok' }],
    outcome: 'completed',
    startedAt: new Date('2026-10-08T10:00:00Z'),
    finishedAt: new Date('2026-10-08T10:00:00.500Z'),
    ...overrides,
  });

  const rowsOf = (tenantId: string) =>
    h.prisma.agentRun.findMany({ where: { tenantId }, orderBy: { startedAt: 'asc' } });

  it('writes a runner-side row, attributed to the tenant runner, cost as reported with provenance', async () => {
    const t = await h.newTenant();
    const runnerId = await runnerOf(t.tenantId);
    const input = report();

    const result = await recordAgentRunReport(repo, t.ctx, input);

    expect(result.created).toBe(true);
    const [row] = await rowsOf(t.tenantId);
    expect(row).toMatchObject({
      id: result.id,
      executedIn: 'runner',
      runnerInstanceId: runnerId,
      costProvenance: 'reported',
      reportId: input.reportId,
      provider: 'anthropic',
      outcome: 'completed',
    });
    expect(row?.cost.toFixed(6)).toBe('0.300000'); // 0.1 + 0.2, no float drift
    expect(row?.finishedAt?.toISOString()).toBe('2026-10-08T10:00:00.500Z');
    expect(row?.toolCalls).toEqual([
      { name: 'read_file', argumentDigest: 'a'.repeat(64), outcome: 'ok' },
    ]);
  });

  it('counts toward the tenant budget exactly once however often the report is delivered', async () => {
    const t = await h.newTenant();
    await runnerOf(t.tenantId);
    const input = report({ cost: 1.5 });

    const first = await recordAgentRunReport(repo, t.ctx, input);
    const again = await recordAgentRunReport(repo, t.ctx, input);

    expect(again).toEqual({ id: first.id, created: false });
    expect(await rowsOf(t.tenantId)).toHaveLength(1);
    expect(
      await query(
        h.pg,
        `select sum(cost) from "agent"."agent_run" where tenant_id = '${t.tenantId}'`,
      ),
    ).toBe('1.500000');
  });

  it('refuses a reportId reused with different content, and leaves the first write alone', async () => {
    const t = await h.newTenant();
    await runnerOf(t.tenantId);
    const input = report({ cost: 1 });
    await recordAgentRunReport(repo, t.ctx, input);

    await expect(recordAgentRunReport(repo, t.ctx, { ...input, cost: 99 })).rejects.toThrow(
      AgentRunReportConflictError,
    );
    const rows = await rowsOf(t.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost.toFixed(6)).toBe('1.000000');
  });

  it('two tenants may use the same reportId: the key is per tenant', async () => {
    const a = await h.newTenant();
    const b = await h.newTenant();
    await runnerOf(a.tenantId);
    await runnerOf(b.tenantId);
    const input = report();

    await recordAgentRunReport(repo, a.ctx, input);
    expect((await recordAgentRunReport(repo, b.ctx, input)).created).toBe(true);
  });

  it('never resolves a runner of another tenant — not found, nothing written', async () => {
    const owner = await h.newTenant();
    const other = await h.newTenant();
    await runnerOf(owner.tenantId, 'owners-runner');

    await expect(
      recordAgentRunReport(repo, other.ctx, report({ runnerName: 'owners-runner' })),
    ).rejects.toThrow(NotFoundError);
    expect(await rowsOf(other.tenantId)).toHaveLength(0);
    expect(await rowsOf(owner.tenantId)).toHaveLength(0);
  });

  it('maps an unresolvable prompt version, issue or policy decision to a typed error', async () => {
    const t = await h.newTenant();
    const other = await h.newTenant();
    await runnerOf(t.tenantId);
    const foreignIssue = await seedIssue(h.pg, other.tenantId);

    const refused = (overrides: Partial<RecordAgentRunReportInput>) =>
      recordAgentRunReport(repo, t.ctx, report(overrides)).catch((e: unknown) => e);

    expect(await refused({ promptVersionId: randomUUID() })).toMatchObject({
      reference: 'prompt_version',
    });
    expect(await refused({ issueId: foreignIssue })).toMatchObject({ reference: 'issue' });
    expect(await refused({ policyDecisionId: randomUUID() })).toMatchObject({
      reference: 'policy_decision',
    });
    expect(await refused({ issueId: foreignIssue })).toBeInstanceOf(AgentRunReferenceNotFoundError);
    expect(await rowsOf(t.tenantId)).toHaveLength(0);
  });

  it('a redelivery that overlaps the first write waits for it and returns it, never a second row', async () => {
    const t = await h.newTenant();
    const runnerId = await runnerOf(t.tenantId);
    const input = report({ cost: 2 });
    const id = randomUUID();
    const holder = await hold(h.prisma, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "agent"."agent_run"
          (id, tenant_id, correlation_id, agent_kind, prompt_version_id, model_id, provider,
           input_tokens, output_tokens, cost, tool_calls, outcome, cost_provenance, started_at,
           finished_at, executed_in, runner_instance_id, report_id)
        VALUES (${id}::uuid, ${t.tenantId}::uuid, ${input.correlationId}::uuid, 'change',
                ${input.promptVersionId}::uuid, ${input.modelId}, 'anthropic', 100, 50, 2,
                ${JSON.stringify(input.toolCalls)}::jsonb, 'completed', 'reported',
                ${input.startedAt}::timestamptz, ${input.finishedAt}::timestamptz, 'runner',
                ${runnerId}::uuid, ${input.reportId}::uuid)`;
    });
    let pending!: Promise<{ id: string; created: boolean }>;
    try {
      pending = recordAgentRunReport(repo, t.ctx, input);
      await waitForBlocked(h.pg, 1, holder); // it is waiting on the first write's unique key
    } finally {
      await holder.release();
    }
    expect(await pending).toEqual({ id, created: false });
    expect(await rowsOf(t.tenantId)).toHaveLength(1);
  });

  describe('the database refuses the unsafe states itself', () => {
    const insert = ({ tenant_id, ...cols }: Record<string, string>) => {
      const all = {
        id: `'${randomUUID()}'`,
        tenant_id: `'${tenant_id}'`,
        correlation_id: `'${randomUUID()}'`,
        agent_kind: `'change'`,
        prompt_version_id: `'${seededPromptVersionId()}'`,
        model_id: `'m'`,
        provider: `'anthropic'`,
        input_tokens: '1',
        output_tokens: '1',
        cost: '1',
        tool_calls: `'[]'`,
        outcome: `'completed'`,
        started_at: 'now()',
        cost_provenance: `'reported'`,
        ...cols,
      };
      return query(
        h.pg,
        `insert into "agent"."agent_run" (${Object.keys(all).join(',')}) values (${Object.values(all).join(',')})`,
      );
    };

    it('a runner-side row must name a runner, and only a runner-side row may', async () => {
      const t = await h.newTenant();
      const runnerId = await runnerOf(t.tenantId);
      await expect(
        insert({ tenant_id: t.tenantId, executed_in: `'runner'`, report_id: `'${randomUUID()}'` }),
      ).rejects.toThrow(/agent_run_runner_iff_runner_instance/);
      await expect(
        insert({ tenant_id: t.tenantId, runner_instance_id: `'${runnerId}'` }),
      ).rejects.toThrow(/agent_run_runner_iff_runner_instance/);
    });

    it('a runner-side row must carry the idempotency key', async () => {
      const t = await h.newTenant();
      const runnerId = await runnerOf(t.tenantId);
      await expect(
        insert({
          tenant_id: t.tenantId,
          executed_in: `'runner'`,
          runner_instance_id: `'${runnerId}'`,
        }),
      ).rejects.toThrow(/agent_run_runner_has_report_id/);
    });

    it('a writer must state the cost provenance — there is no default to hide a wrong value', async () => {
      const t = await h.newTenant();
      await expect(
        query(
          h.pg,
          `insert into "agent"."agent_run" (id, tenant_id, correlation_id, agent_kind, prompt_version_id,
             model_id, provider, input_tokens, output_tokens, cost, tool_calls, outcome, started_at)
           values ('${randomUUID()}', '${t.tenantId}', '${randomUUID()}', 'change',
             '${seededPromptVersionId()}', 'm', 'anthropic', 1, 1, 1, '[]', 'completed', now())`,
        ),
      ).rejects.toThrow(/cost_provenance/);
    });

    it('a runner registration that has reported spend cannot be deleted from under it', async () => {
      const t = await h.newTenant();
      const runnerId = await runnerOf(t.tenantId);
      await recordAgentRunReport(repo, t.ctx, report());
      await expect(
        query(h.pg, `delete from "runner"."runner_registration" where id = '${runnerId}'`),
      ).rejects.toThrow(/agent_run_runner_instance_id_fkey/);
    });
  });
});
