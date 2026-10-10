import { scope, type TenantContext } from '@healer/shared';
import { toCostDecimal } from '../../domain/agent-run-cost.js';
import type {
  AgentRunReportRecord,
  AgentRunRepository,
} from '../../domain/agent-run-repository.js';

/** What a runner's report says, before the cost is made into a column literal. */
export type RecordAgentRunReportInput = Omit<AgentRunReportRecord, 'cost'> & {
  readonly cost: number;
};

/**
 * `agent_run` from an `agent_run_report` (012 T094). `context` is the authenticated tenant — the
 * only source of `tenantId` — and the repository resolves `runnerName` against that tenant's
 * registrations alone. Idempotent on `reportId`: a redelivery returns `created: false` and charges
 * nothing twice. The cost is recorded as reported, with provenance `reported` (see the repository).
 */
export function recordAgentRunReport(
  repo: AgentRunRepository,
  context: TenantContext,
  input: RecordAgentRunReportInput,
): Promise<{ id: string; created: boolean }> {
  return repo.record(scope(context, { ...input, cost: toCostDecimal(input.cost) }));
}
