import { randomUUID } from 'node:crypto';
import { Prisma, type AgentRun, type PrismaClient, type ProviderName } from '@healer/prisma-client';
import { NotFoundError, type TenantScoped } from '@healer/shared';
import {
  AgentRunReferenceNotFoundError,
  AgentRunReportConflictError,
  type AgentRunReportRecord,
  type AgentRunRepository,
} from '../domain/agent-run-repository.js';

type Tx = Prisma.TransactionClient;

/** The issue and the allowed decision a report names must belong to the tenant. An allowed
 *  decision because the link is what replaces its open charge with the actual cost
 *  (budget-aggregate.ts); any other would unbalance the budget. */
async function assertReferencesResolve(
  tx: Tx,
  input: TenantScoped<AgentRunReportRecord>,
): Promise<void> {
  const { tenantId } = input;
  if (input.issueId !== undefined) {
    const issue = await tx.issue.findFirst({ where: { id: input.issueId, tenantId } });
    if (issue === null) throw new AgentRunReferenceNotFoundError('issue');
  }
  if (input.policyDecisionId !== undefined) {
    const decision = await tx.policyDecision.findFirst({
      where: { id: input.policyDecisionId, tenantId, outcome: 'allow' },
    });
    if (decision === null) throw new AgentRunReferenceNotFoundError('policy_decision');
  }
}

/** A redelivery is identical by construction; a difference is a reused id. */
function isSameReport(
  existing: AgentRun,
  input: TenantScoped<AgentRunReportRecord>,
  runnerId: string,
): boolean {
  return (
    existing.runnerInstanceId === runnerId &&
    existing.correlationId === input.correlationId &&
    existing.promptVersionId === input.promptVersionId &&
    existing.modelId === input.modelId &&
    existing.inputTokens === input.inputTokens &&
    existing.outputTokens === input.outputTokens &&
    existing.cost.toFixed(6) === input.cost
  );
}

/**
 * `agent_run` written from a runner's report (012 T094). The mechanisms that refuse a bad write
 * live in the database, not in this file: `agent_run_runner_iff_runner_instance` (a runner-side row
 * names a runner and only one does), the `(tenant_id, report_id)` unique index (a report is stored
 * once), the `prompt_version` foreign key (the prompt must resolve) and `cost_provenance` having no
 * default. This file only chooses the values: `executed_in = 'runner'`, the runner resolved from
 * the authenticated tenant's own registrations, and `cost_provenance = 'reported'` — never
 * `measured`, which no writer can honestly claim until reported cost is reconciled against provider
 * usage (not built: no provider usage source exists).
 *
 * Idempotency is `INSERT ... ON CONFLICT DO NOTHING` (`createMany`'s `skipDuplicates`): a second
 * delivery that overlaps the first waits on the first's unique key and then inserts nothing, so
 * there is no read-then-write for a race to slip through.
 */
export class PrismaAgentRunRepository implements AgentRunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(
    input: TenantScoped<AgentRunReportRecord>,
  ): Promise<{ id: string; created: boolean }> {
    const { tenantId } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const runner = await tx.runnerRegistration.findUnique({
          where: { tenantId_name: { tenantId, name: input.runnerName } },
          select: { id: true },
        });
        // Another tenant's runner of the same name is not this tenant's: not found, not forbidden.
        if (runner === null) throw new NotFoundError('runner');
        await assertReferencesResolve(tx, input);

        const id = randomUUID();
        const { count } = await tx.agentRun.createMany({
          skipDuplicates: true,
          data: {
            id,
            tenantId,
            issueId: input.issueId ?? null,
            correlationId: input.correlationId,
            agentKind: input.agentKind,
            promptVersionId: input.promptVersionId,
            modelId: input.modelId,
            provider: input.provider as ProviderName,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cost: input.cost,
            toolCalls: [...input.toolCalls],
            policyDecisionId: input.policyDecisionId ?? null,
            outcome: input.outcome,
            startedAt: input.startedAt,
            finishedAt: input.finishedAt,
            executedIn: 'runner',
            runnerInstanceId: runner.id,
            costProvenance: 'reported',
            reportId: input.reportId,
          },
        });
        if (count === 1) return { id, created: true };

        const existing = await tx.agentRun.findUniqueOrThrow({
          where: { tenantId_reportId: { tenantId, reportId: input.reportId } },
        });
        const same = isSameReport(existing, input, runner.id);
        if (!same) throw new AgentRunReportConflictError();
        return { id: existing.id, created: false };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003' &&
        JSON.stringify(error.meta ?? {}).includes('prompt_version')
      ) {
        throw new AgentRunReferenceNotFoundError('prompt_version');
      }
      throw error;
    }
  }
}
