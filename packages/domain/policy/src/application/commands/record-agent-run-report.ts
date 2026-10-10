import { scope, type TenantContext } from '@healer/shared';
import { toCostDecimal } from '../../domain/agent-run-cost.js';
import { MAX_EVALUATION_SKEW_MS } from '../../domain/budget-bounds.js';
import { EvaluationInstantError } from '../../domain/budget-repository.js';
import type {
  AgentRunReportRecord,
  AgentRunRepository,
} from '../../domain/agent-run-repository.js';

/** What a runner's report says, before the cost and the finish instant are derived. */
export type RecordAgentRunReportInput = Omit<AgentRunReportRecord, 'cost' | 'finishedAt'> & {
  readonly cost: number;
  readonly durationMs: number;
};

/**
 * `agent_run` from an `agent_run_report` (012 T094). `context` is the authenticated tenant — the
 * only source of `tenantId` — and the repository resolves `runnerName` against that tenant's
 * registrations alone. Idempotent on `reportId`: a redelivery returns `created: false` and charges
 * nothing twice. The cost is recorded as reported, with provenance `reported` (see the repository).
 *
 * The runner chooses `startedAt` and `durationMs`, and the finish instant picks the budget window
 * a landed run is charged to. So the refusing mechanism is here, before any write: a run that
 * *finished* further from the **database** clock than an enforcing evaluation tolerates
 * (`MAX_EVALUATION_SKEW_MS`, the same bound `assertEvaluable` applies) is an `EvaluationInstantError`.
 * A start in the future is refused by the same check (the finish is never before it); a start long
 * ago is fine when the run itself was long — the finish is what a prompt report pins.
 */
export async function recordAgentRunReport(
  repo: AgentRunRepository,
  context: TenantContext,
  input: RecordAgentRunReportInput,
  options: { readonly maxSkewMs?: number } = {},
): Promise<{ id: string; created: boolean }> {
  const maxSkewMs = options.maxSkewMs ?? MAX_EVALUATION_SKEW_MS;
  const { durationMs, ...rest } = input;
  const finishedAt = new Date(input.startedAt.getTime() + Math.round(durationMs));
  const now = await repo.databaseNow();
  const finishSkew = Math.abs(finishedAt.getTime() - now.getTime());
  if (finishSkew > maxSkewMs) throw new EvaluationInstantError(finishSkew, maxSkewMs);
  return repo.record(scope(context, { ...rest, cost: toCostDecimal(input.cost), finishedAt }));
}
