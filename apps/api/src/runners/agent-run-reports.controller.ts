import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Inject,
  NotFoundException,
  Post,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AgentRunReportEnvelope } from '@healer/boundary-contract';
import { recordAgentRunReport, type AgentRunRepository } from '@healer/domain-policy';
import {
  TenantContext,
  TenantIsolationError,
  createLogger,
  newCorrelationId,
  withCorrelation,
} from '@healer/shared';
import { refusalFor } from './agent-run-report-refusal.js';

export const AGENT_RUN_REPOSITORY = Symbol('AGENT_RUN_REPOSITORY');

/**
 * `POST /runners/agent-run-reports` (012 T094, FR-033, FR-046a, ADR 0010): a runner reports one
 * model call it made in its own process, and the control plane writes the `agent_run`. Thin by
 * rule: parse, dispatch `recordAgentRunReport`, translate errors.
 *
 * The runner is identified by `X-Runner-Name`, which is **only the lookup key into the
 * authenticated tenant's own `runner_registration` rows** — not a credential. Like the tenant
 * itself it is unauthenticated until the real runner credential exists (the same stub as
 * `RunnersController`'s heartbeat), so today anyone who can reach this endpoint with a tenant id
 * and a registered runner name can record spend for that tenant. A runner of another tenant is a
 * 404 and writes nothing; what the stub cannot do is prove the caller *is* that runner.
 */
@Controller('runners')
export class AgentRunReportsController {
  // Every refusal is logged here (reportId, runner name, a closed reason code — never a payload
  // field): a 409 or 422 is a runner that believes its spend was recorded and it was not.
  protected logger: { warn(fields: object, message: string): void } = createLogger();

  constructor(@Inject(AGENT_RUN_REPOSITORY) private readonly agentRuns: AgentRunRepository) {}

  private refuse(
    status: 400 | 404 | 409 | 422,
    reason: string,
    message: unknown,
    runnerName?: string,
    reportId?: string,
  ): never {
    this.logger.warn(
      { status, reason, reportId, runnerName: runnerName?.slice(0, 200) },
      'agent run report refused',
    );
    if (status === 404) throw new NotFoundException(message);
    if (status === 409) throw new ConflictException(message);
    if (status === 422) throw new UnprocessableEntityException(message);
    throw new BadRequestException(message);
  }

  // TODO(012 T094, security): stub auth — the same deliberate stub as every other controller in this
  // app (TODO(001 T019, security)); no credential is verified yet, so the tenant (and the runner
  // name below) is whatever the caller says.
  private resolveTenant(tenantIdHeader: string | undefined, runnerName?: string): TenantContext {
    try {
      return TenantContext.forTrustedInternalUse(tenantIdHeader ?? '');
    } catch (error) {
      if (error instanceof TenantIsolationError) {
        this.refuse(
          400,
          'bad_tenant',
          'X-Tenant-Id header is missing or not a valid tenant id',
          runnerName,
        );
      }
      throw error;
    }
  }

  @Post('agent-run-reports')
  async record(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('x-runner-name') runnerName?: string,
  ): Promise<{ id: string; created: boolean }> {
    return withCorrelation(newCorrelationId(), async () => {
      const context = this.resolveTenant(tenantIdHeader, runnerName);
      if (runnerName === undefined || runnerName === '') {
        return this.refuse(400, 'missing_runner_name', 'X-Runner-Name header is required');
      }
      const parsed = AgentRunReportEnvelope.safeParse(body);
      if (!parsed.success) {
        const id = (body as { reportId?: unknown } | null)?.reportId;
        return this.refuse(
          400,
          'bad_envelope',
          parsed.error.flatten(),
          runnerName,
          typeof id === 'string' ? id.slice(0, 64) : undefined,
        );
      }
      const { reportId, report, correlationId, issueId, policyDecisionId, startedAt } = parsed.data;

      try {
        const result = await recordAgentRunReport(this.agentRuns, context, {
          reportId,
          runnerName,
          correlationId,
          ...(issueId !== undefined ? { issueId } : {}),
          ...(policyDecisionId !== undefined ? { policyDecisionId } : {}),
          agentKind: report.agentKind,
          modelId: report.modelId,
          provider: report.provider,
          promptVersionId: report.promptVersionId,
          inputTokens: report.inputTokens,
          outputTokens: report.outputTokens,
          cost: report.cost,
          toolCalls: report.toolCalls,
          outcome: report.outcome,
          startedAt: new Date(startedAt),
          durationMs: report.durationMs,
        });
        response.status(result.created ? 201 : 200);
        return result;
      } catch (error) {
        const refusal = refusalFor(error);
        if (refusal === null) throw error;
        return this.refuse(refusal.status, refusal.reason, refusal.message, runnerName, reportId);
      }
    });
  }
}
