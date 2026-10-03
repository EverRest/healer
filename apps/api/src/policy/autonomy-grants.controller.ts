import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CeilingExceededError,
  UndoNotAttestedError,
  GrantAlreadyRevokedError,
  grantAutonomy,
  revokeAutonomy,
  UnregisteredActionError,
  type AutonomyGrant,
  type AutonomyGrantRepository,
  type PolicyActionRepository,
} from '@healer/domain-policy';
import { newCorrelationId, NotFoundError, scope, withCorrelation } from '@healer/shared';
import { grantAutonomyRequestSchema } from './grant-autonomy.dto.js';
import {
  AUTONOMY_GRANT_REPOSITORY,
  requireIdempotencyKey,
  resolveActor,
  resolveTenant,
  UUID_PATTERN,
} from './policy-http.js';
import { POLICY_ACTION_REPOSITORY } from './policy-evaluation.controller.js';

export { AUTONOMY_GRANT_REPOSITORY };

function serializeGrant(grant: AutonomyGrant) {
  return {
    id: grant.id,
    componentId: grant.componentId ?? null,
    environment: grant.environment ?? null,
    issueKind: grant.issueKind ?? null,
    actionKey: grant.actionKey,
    level: grant.level,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    revokedBy: grant.revokedBy ?? null,
    revokedAt: grant.revokedAt ?? null,
  };
}

/**
 * `GET /autonomy/grants`, `POST /autonomy/grants`, `DELETE /autonomy/grants/{grantId}` (T046,
 * FR-007). `POST` dispatches `grantAutonomy` (`422 CEILING_EXCEEDED` for a level the action's
 * class can never carry, T034/T037); `DELETE` dispatches `revokeAutonomy`, which bumps the
 * tenant's autonomy epoch in the same transaction as the revocation (T043, R-07) — a later
 * evaluation for this tenant sees the effect with no push mechanism involved.
 */
@Controller('autonomy/grants')
export class AutonomyGrantsController {
  constructor(
    @Inject(AUTONOMY_GRANT_REPOSITORY) private readonly grants: AutonomyGrantRepository,
    @Inject(POLICY_ACTION_REPOSITORY) private readonly actions: PolicyActionRepository,
  ) {}

  @Get()
  async list(
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ items: readonly unknown[] }> {
    const context = resolveTenant(tenantIdHeader);
    const items = await this.grants.list(scope(context, {}));
    return { items: items.map(serializeGrant) };
  }

  @Post()
  @HttpCode(201)
  async grant(
    @Body() body: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('x-actor-id') actorIdHeader?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    requireIdempotencyKey(idempotencyKey);
    const actor = resolveActor(actorIdHeader);

    const parsed = grantAutonomyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `invalid grant request: ${parsed.error.issues[0]?.message ?? 'malformed request'}`,
      );
    }

    const { actionKey, level, componentId, environment, issueKind } = parsed.data;
    try {
      const granted = await withCorrelation(newCorrelationId(), () =>
        grantAutonomy({ grants: this.grants, actions: this.actions }, context, {
          actionKey,
          level,
          grantedBy: actor,
          ...(componentId !== undefined ? { componentId } : {}),
          ...(environment !== undefined ? { environment } : {}),
          ...(issueKind !== undefined ? { issueKind } : {}),
        }),
      );
      return serializeGrant(granted);
    } catch (error) {
      if (
        error instanceof CeilingExceededError ||
        error instanceof UndoNotAttestedError ||
        error instanceof UnregisteredActionError
      ) {
        // `code` is what tells UNDO_NOT_ATTESTED apart from CEILING_EXCEEDED (both 422).
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  }

  @Delete(':grantId')
  @HttpCode(200)
  async revoke(
    @Param('grantId') grantId: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('x-actor-id') actorIdHeader?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    const actor = resolveActor(actorIdHeader);
    // `id` is a `@db.Uuid` column: a malformed id can match nothing, so it is a 404, not a 500.
    if (!UUID_PATTERN.test(grantId))
      throw new NotFoundException(`autonomy grant ${grantId} not found`);

    try {
      const revoked = await withCorrelation(newCorrelationId(), () =>
        revokeAutonomy({ grants: this.grants }, context, { grantId, revokedBy: actor }),
      );
      return serializeGrant(revoked);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`autonomy grant ${grantId} not found`);
      }
      if (error instanceof GrantAlreadyRevokedError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}
