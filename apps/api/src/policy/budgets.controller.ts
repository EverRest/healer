import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Put,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BUDGET_DEFAULTS,
  BudgetBoundExceededError,
  BudgetScopePeriodError,
  getBudgetState,
  putBudgetLimit,
  type BudgetLimit,
  type BudgetLimitRepository,
  type BudgetRepository,
} from '@healer/domain-policy';
import type { IssueRepository } from '@healer/domain-issues';
import { newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { budgetStateQuerySchema, putBudgetRequestSchema } from './budgets.dto.js';
import {
  BUDGET_REPOSITORY,
  requireIdempotencyKey,
  resolveActor,
  resolveTenant,
} from './policy-http.js';
import { ISSUE_REPOSITORY } from '../issues/issues.controller.js';

export { BUDGET_REPOSITORY };
export const BUDGET_LIMIT_REPOSITORY = Symbol('BUDGET_LIMIT_REPOSITORY');

/**
 * `GET /budgets`, `PUT /budgets`, `GET /budgets/state` (T067, FR-011, FR-020). Thin: DTO +
 * dispatch. `PUT` is audited and bounded by `putBudgetLimit` (FR-020, FR-021); `state` reads the
 * same derived aggregate policy enforces — nothing here keeps a counter (R-10).
 */
@Controller('budgets')
export class BudgetsController {
  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly budgets: BudgetRepository,
    @Inject(BUDGET_LIMIT_REPOSITORY) private readonly limits: BudgetLimitRepository,
    @Inject(ISSUE_REPOSITORY) private readonly issues: IssueRepository,
  ) {}

  @Get()
  async list(@Headers('x-tenant-id') tenantIdHeader?: string): Promise<{ items: unknown[] }> {
    const context = resolveTenant(tenantIdHeader);
    const items = await this.limits.list(scope(context, {}));
    return { items: items.map((l) => ({ ...l, softThresholdPcts: [...l.softThresholdPcts] })) };
  }

  @Put()
  @HttpCode(200)
  async put(
    @Body() body: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('x-actor-id') actorIdHeader?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    requireIdempotencyKey(idempotencyKey);
    const actor = resolveActor(actorIdHeader);
    const parsed = putBudgetRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `invalid budget: ${parsed.error.issues[0]?.message ?? 'malformed request'}`,
      );
    }
    const req = parsed.data;

    // A partial write keeps what is already configured; where nothing is, the fail-closed
    // default (FR-021) — an omitted field never becomes "unbounded".
    const existing: BudgetLimit | undefined = (await this.limits.list(scope(context, {}))).find(
      (l) => l.scopeType === req.scopeType && l.period === req.period,
    );
    try {
      await withCorrelation(newCorrelationId(), () =>
        putBudgetLimit(this.limits, context, {
          scopeType: req.scopeType,
          period: req.period,
          spendLimit:
            req.spendLimit ?? existing?.spendLimit ?? BUDGET_DEFAULTS.spendLimit[req.period],
          timeLimitMs:
            req.timeLimitMs ?? existing?.timeLimitMs ?? BUDGET_DEFAULTS.timeLimitMs[req.period],
          softThresholdPcts:
            req.softThresholdPcts ??
            existing?.softThresholdPcts ??
            BUDGET_DEFAULTS.softThresholdPcts,
          escalationAttemptCap:
            req.escalationAttemptCap ??
            existing?.escalationAttemptCap ??
            BUDGET_DEFAULTS.escalationAttemptCap,
          updatedBy: actor,
        }),
      );
    } catch (error) {
      if (error instanceof BudgetBoundExceededError || error instanceof BudgetScopePeriodError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
    return { updated: true };
  }

  @Get('state')
  async state(
    @Query() query: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    const parsed = budgetStateQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `invalid query: ${parsed.error.issues[0]?.message ?? 'malformed request'}`,
      );
    }
    const q = parsed.data;
    if (q.scopeType === 'issue') {
      if (q.scopeId === undefined) {
        throw new UnprocessableEntityException('scopeId is required for scopeType=issue');
      }
      // Another tenant's issue is not-found, never forbidden (FR-018, SC-008).
      const issue = await this.issues.findById(scope(context, { id: q.scopeId }));
      if (issue === null) throw new NotFoundException(`issue ${q.scopeId} not found`);
    }
    const state = await getBudgetState(this.budgets, context, {
      scopeType: q.scopeType,
      ...(q.scopeId !== undefined ? { scopeId: q.scopeId } : {}),
      ...(q.period !== undefined ? { period: q.period } : {}),
      ...(q.workflowRunId !== undefined ? { workflowRunId: q.workflowRunId } : {}),
      asOf: new Date(),
    });
    if (state === null) throw new NotFoundException('no budget scope matches the request');
    return state;
  }
}
