import {
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Body,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApprovalNotPendingError,
  resolveApproval,
  StaleAutonomyEpochError,
  type ApprovalLifecycleRepository,
  type ApprovalRequest,
} from '@healer/domain-policy';
import { newCorrelationId, NotFoundError, scope, withCorrelation } from '@healer/shared';
import { z } from 'zod';
import { requireIdempotencyKey, resolveActor, resolveTenant, UUID_PATTERN } from './policy-http.js';

export const APPROVAL_LIFECYCLE_REPOSITORY = Symbol('APPROVAL_LIFECYCLE_REPOSITORY');

const STATES = ['pending', 'approved', 'rejected', 'expired', 'revoked'] as const;

/** `POST /approvals/{id}/resolve` body (T075). The approver's identity is never in it: it comes
 *  from the authenticated context (`X-Actor-Id`), same as every other mutation here. */
export const resolveApprovalRequestSchema = z
  .object({
    resolution: z.enum(['approved', 'rejected']),
    note: z.string().max(500).optional(),
  })
  .strict();

function serializeApproval(approval: ApprovalRequest) {
  return {
    id: approval.id,
    decisionId: approval.decisionId,
    workflowRunId: approval.workflowRunId,
    state: approval.state,
    expiresAt: approval.expiresAt,
    summary: approval.summary,
    evidenceIds: approval.evidenceIds,
    rulesetVersion: approval.rulesetVersion,
    resolvedBy: approval.resolvedBy ?? null,
    resolvedAt: approval.resolvedAt ?? null,
  };
}

/**
 * `GET /approvals`, `GET /approvals/{approvalId}`, `POST /approvals/{approvalId}/resolve`
 * (T075, FR-015, FR-017). The read shows what the approver decides on — identifiers and
 * structured fields only (T071). `resolve` dispatches `resolveApproval`, which runs the
 * redemption guard (pending, not lapsed, epoch current) under the row lock; every refusal is
 * `409`, and another tenant's approval is `404`, never `403` (FR-018, SC-008).
 */
@Controller('approvals')
export class ApprovalsController {
  constructor(
    @Inject(APPROVAL_LIFECYCLE_REPOSITORY) private readonly approvals: ApprovalLifecycleRepository,
  ) {}

  @Get()
  async list(
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Query('state') state?: string,
    @Query('issueId') issueId?: string,
  ): Promise<{ items: readonly unknown[] }> {
    const context = resolveTenant(tenantIdHeader);
    if (state !== undefined && !(STATES as readonly string[]).includes(state)) {
      throw new UnprocessableEntityException(`state must be one of ${STATES.join(', ')}`);
    }
    if (issueId !== undefined && !UUID_PATTERN.test(issueId)) {
      throw new UnprocessableEntityException('issueId must be a UUID');
    }
    const items = await this.approvals.list(
      scope(context, {
        ...(state !== undefined ? { state: state as (typeof STATES)[number] } : {}),
        ...(issueId !== undefined ? { issueId } : {}),
      }),
    );
    return { items: items.map(serializeApproval) };
  }

  @Get(':approvalId')
  async get(
    @Param('approvalId') approvalId: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    const approval = await this.approvals.findById(scope(context, { id: approvalId }));
    if (approval === null) throw new NotFoundException(`approval ${approvalId} not found`);
    return serializeApproval(approval);
  }

  @Post(':approvalId/resolve')
  @HttpCode(200)
  async resolve(
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('x-actor-id') actorIdHeader?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    requireIdempotencyKey(idempotencyKey);
    const actor = resolveActor(actorIdHeader);
    const parsed = resolveApprovalRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `invalid resolve request: ${parsed.error.issues[0]?.message ?? 'malformed request'}`,
      );
    }

    try {
      const resolved = await withCorrelation(newCorrelationId(), () =>
        resolveApproval({ approvals: this.approvals }, context, {
          approvalId,
          resolution: parsed.data.resolution,
          resolvedBy: actor,
          ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
        }),
      );
      return serializeApproval(resolved);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`approval ${approvalId} not found`);
      }
      if (error instanceof ApprovalNotPendingError || error instanceof StaleAutonomyEpochError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}
