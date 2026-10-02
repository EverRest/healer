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
  BudgetBoundExceededError,
  BudgetThresholdsInvalidError,
  BudgetScopePeriodError,
  getBudgetState,
  putBudgetLimit,
  type BudgetLimitRepository,
  type BudgetRepository,
} from '@healer/domain-policy';
import type { IssueRepository } from '@healer/domain-issues';
import { newCorrelationId, NotFoundError, scope, withCorrelation } from '@healer/shared';
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

    // A partial write is merged over the limit **in force** (the stored row, else 012's
    // tenant_budget, else the product default) inside the repository's transaction — never here,
    // where a concurrent write could be lost and an inherited limit reverted to a default.
    try {
      await withCorrelation(newCorrelationId(), () =>
        putBudgetLimit(this.limits, context, {
          scopeType: req.scopeType,
          period: req.period,
          ...(req.spendLimit !== undefined ? { spendLimit: req.spendLimit } : {}),
          ...(req.timeLimitMs !== undefined ? { timeLimitMs: req.timeLimitMs } : {}),
          ...(req.softThresholdPcts !== undefined
            ? { softThresholdPcts: req.softThresholdPcts }
            : {}),
          ...(req.escalationAttemptCap !== undefined
            ? { escalationAttemptCap: req.escalationAttemptCap }
            : {}),
          updatedBy: actor,
        }),
      );
    } catch (error) {
      if (
        error instanceof BudgetBoundExceededError ||
        error instanceof BudgetThresholdsInvalidError ||
        error instanceof BudgetScopePeriodError
      ) {
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
    let state;
    try {
      state = await getBudgetState(this.budgets, context, {
        scopeType: q.scopeType,
        ...(q.scopeId !== undefined ? { scopeId: q.scopeId } : {}),
        ...(q.period !== undefined ? { period: q.period } : {}),
        ...(q.workflowRunId !== undefined ? { workflowRunId: q.workflowRunId } : {}),
        asOf: new Date(),
      });
    } catch (error) {
      // An unknown or other-tenant workflow run is not-found, never a silent fresh window.
      if (error instanceof NotFoundError) throw new NotFoundException(error.message);
      throw error;
    }
    if (state === null) throw new NotFoundException('no budget scope matches the request');
    return state;
  }
}
