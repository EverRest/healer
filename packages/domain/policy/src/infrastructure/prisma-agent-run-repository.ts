import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type AgentKind,
  type AgentRun,
  type PrismaClient,
  type ProviderName,
} from '@healer/prisma-client';
import { NotFoundError, type TenantScoped } from '@healer/shared';
import {
  AgentRunReferenceNotFoundError,
  AgentRunReportConflictError,
  type AgentRunReportRecord,
  type AgentRunRepository,
} from '../domain/agent-run-repository.js';

type Tx = Prisma.TransactionClient;
type Input = TenantScoped<AgentRunReportRecord>;

/**
 * The issue and the policy decision a report names must be ones this report may land. A landed
 * decision's open charge is replaced by the run's actual cost (budget-aggregate.ts), so a decision
 * that is another tenant's, a deny, invalidated, bound to a different issue or workflow run, or
 * already landed by a finished run would release or double-count a charge it does not own. Every
 * such case throws the same error as a decision that does not exist: no existence leak.
 */
async function assertReferencesResolve(tx: Tx, input: Input): Promise<void> {
  const { tenantId } = input;
  if (input.issueId !== undefined) {
    const issue = await tx.issue.findFirst({ where: { id: input.issueId, tenantId } });
    if (issue === null) throw new AgentRunReferenceNotFoundError('issue');
  }
  if (input.policyDecisionId === undefined) return;
  const refused = new AgentRunReferenceNotFoundError('policy_decision');
  const decision = await tx.policyDecision.findFirst({
    where: {
      id: input.policyDecisionId,
      tenantId,
      outcome: 'allow',
      invalidatedReason: null,
      issueId: input.issueId ?? null,
    },
    select: { workflowRunId: true },
  });
  if (decision === null) throw refused;
  if (decision.workflowRunId !== null) {
    const run = await tx.workflowRun.findFirst({
      where: { id: decision.workflowRunId, tenantId, correlationId: input.correlationId },
    });
    if (run === null) throw refused;
  }
  const landed = await tx.agentRun.findFirst({
    where: { tenantId, policyDecisionId: input.policyDecisionId, finishedAt: { not: null } },
  });
  if (landed !== null) throw refused;
}

type Call = { name: string; argumentDigest: string; outcome: string };

/** Every column the report writes, in a comparable form (tool calls as tuples — jsonb reorders
 *  keys; instants as epoch ms). Two writes of one report have equal fingerprints; a reused id with
 *  any different attribution does not. */
const fingerprint = (r: {
  runnerInstanceId: string | null;
  issueId: string | null;
  policyDecisionId: string | null;
  correlationId: string;
  agentKind: string;
  promptVersionId: string;
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cost: string;
  outcome: string;
  startedAt: Date;
  finishedAt: Date | null;
  toolCalls: readonly Call[];
}) =>
  JSON.stringify([
    r.runnerInstanceId,
    r.issueId,
    r.policyDecisionId,
    r.correlationId,
    r.agentKind,
    r.promptVersionId,
    r.modelId,
    r.provider,
    r.inputTokens,
    r.outputTokens,
    r.cost,
    r.outcome,
    r.startedAt.getTime(),
    r.finishedAt?.getTime() ?? null,
    r.toolCalls.map((c) => [c.name, c.argumentDigest, c.outcome]),
  ]);

/** A redelivery is identical by construction. EVERY column the report writes is compared, so a
 *  reused id can never silently attach different attribution to the first write. */
function isSameReport(existing: AgentRun, input: Input, runnerId: string): boolean {
  return (
    fingerprint({
      ...existing,
      cost: existing.cost.toFixed(6),
      toolCalls: existing.toolCalls as unknown as Call[],
    }) ===
    fingerprint({
      runnerInstanceId: runnerId,
      issueId: input.issueId ?? null,
      policyDecisionId: input.policyDecisionId ?? null,
      correlationId: input.correlationId,
      agentKind: input.agentKind,
      promptVersionId: input.promptVersionId,
      modelId: input.modelId,
      provider: input.provider,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cost: input.cost,
      outcome: input.outcome,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      toolCalls: input.toolCalls,
    })
  );
}

/**
 * `agent_run` written from a runner's report (012 T094). The mechanisms that refuse a bad write
 * live in the database, not in this file: `agent_run_runner_iff_runner_instance` (a runner-side row
 * names a runner and only one does), the composite `(tenant_id, runner_instance_id)` foreign key
 * (that runner is the tenant's own), the `(tenant_id, report_id)` unique index (a report is stored
 * once), `agent_run_finished_decision_key` (a decision is landed by one finished run), the
 * `prompt_version` foreign key and `cost_provenance` having no default. This file chooses the
 * values: `executed_in = 'runner'`, the runner resolved from the authenticated tenant's own
 * registrations, and `cost_provenance = 'reported'` — never `measured`, which no writer can
 * honestly claim until reported cost is reconciled against provider usage (not built).
 *
 * Idempotency is `INSERT ... ON CONFLICT DO NOTHING` (`createMany`'s `skipDuplicates`): a delivery
 * that overlaps another waits on its unique key and inserts nothing. A row that was not inserted is
 * either the same report (compared in full, else a conflict) or a different report that lost the
 * race for a decision (refused as a policy decision, never silently dropped).
 */
export class PrismaAgentRunRepository implements AgentRunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async databaseNow(): Promise<Date> {
    const [row] = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return row?.now ?? new Date();
  }

  async record(input: Input): Promise<{ id: string; created: boolean }> {
    const { tenantId } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const runner = await tx.runnerRegistration.findUnique({
          where: { tenantId_name: { tenantId, name: input.runnerName } },
          select: { id: true },
        });
        // Another tenant's runner of the same name is not this tenant's: not found, not forbidden.
        if (runner === null) throw new NotFoundError('runner');

        // A redelivery is answered before references are re-checked: its decision is, by then,
        // landed by this very row.
        const already = await findReport(tx, input);
        if (already !== null) return answerFor(already, input, runner.id);
        await assertReferencesResolve(tx, input);

        const id = randomUUID();
        const { count } = await tx.agentRun.createMany({
          skipDuplicates: true,
          data: {
            id,
            tenantId,
            issueId: input.issueId ?? null,
            correlationId: input.correlationId,
            agentKind: input.agentKind as AgentKind,
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

        const winner = await findReport(tx, input);
        if (winner === null) throw new AgentRunReferenceNotFoundError('policy_decision');
        return answerFor(winner, input, runner.id);
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

const findReport = (tx: Tx, input: Input) =>
  tx.agentRun.findUnique({
    where: { tenantId_reportId: { tenantId: input.tenantId, reportId: input.reportId } },
  });

function answerFor(existing: AgentRun, input: Input, runnerId: string) {
  if (!isSameReport(existing, input, runnerId)) throw new AgentRunReportConflictError();
  return { id: existing.id, created: false };
}
