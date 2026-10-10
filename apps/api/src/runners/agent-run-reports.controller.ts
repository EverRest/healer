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
import {
  AgentRunReferenceNotFoundError,
  AgentRunReportConflictError,
  recordAgentRunReport,
  type AgentRunRepository,
} from '@healer/domain-policy';
import {
  HealerError,
  NotFoundError,
  TenantContext,
  TenantIsolationError,
  newCorrelationId,
  withCorrelation,
} from '@healer/shared';

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
  constructor(@Inject(AGENT_RUN_REPOSITORY) private readonly agentRuns: AgentRunRepository) {}

  // Same deliberate, TODO-flagged stub-auth pattern as every other controller in this app (001
  // T019) — no credential is verified yet.
  private resolveTenant(tenantIdHeader: string | undefined): TenantContext {
    try {
      return TenantContext.forTrustedInternalUse(tenantIdHeader ?? '');
    } catch (error) {
      if (error instanceof TenantIsolationError) {
        throw new BadRequestException('X-Tenant-Id header is missing or not a valid tenant id');
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
      const context = this.resolveTenant(tenantIdHeader);
      if (runnerName === undefined || runnerName === '') {
        throw new BadRequestException('X-Runner-Name header is required');
      }
      const parsed = AgentRunReportEnvelope.safeParse(body);
      if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
      const { reportId, report, correlationId, issueId, policyDecisionId, startedAt } = parsed.data;
      const started = new Date(startedAt);

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
          startedAt: started,
          finishedAt: new Date(started.getTime() + Math.round(report.durationMs)),
        });
        response.status(result.created ? 201 : 200);
        return result;
      } catch (error) {
        if (error instanceof NotFoundError) throw new NotFoundException(error.message);
        if (error instanceof AgentRunReportConflictError) {
          throw new ConflictException(error.message);
        }
        if (error instanceof AgentRunReferenceNotFoundError || error instanceof HealerError) {
          throw new UnprocessableEntityException(error.message);
        }
        throw error;
      }
    });
  }
}
