import { BadRequestException } from '@nestjs/common';
import { TenantContext, TenantIsolationError } from '@healer/shared';

/** Shared by every `/policy/*` controller — same deliberate, TODO-flagged stub-auth pattern as
 *  `IssuesController.resolveTenant` (001 T019): no credential is verified yet. */
export function resolveTenant(tenantIdHeader: string | undefined): TenantContext {
  try {
    return TenantContext.forTrustedInternalUse(tenantIdHeader ?? '');
  } catch (error) {
    if (error instanceof TenantIsolationError) {
      throw new BadRequestException('X-Tenant-Id header is missing or not a valid tenant id');
    }
    throw error;
  }
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_ACTOR_LENGTH = 128;

/** `X-Actor-Id` — same caller-asserted stub convention as `IssuesController.close` (001 T057). */
export function resolveActor(actorIdHeader: string | undefined): string {
  const actor = actorIdHeader?.trim() ?? '';
  if (actor === '' || actor.length > MAX_ACTOR_LENGTH) {
    throw new BadRequestException(
      `X-Actor-Id header is required (1-${MAX_ACTOR_LENGTH} characters)`,
    );
  }
  return actor;
}

/** `Idempotency-Key` — required and shape-validated, not stored (same known gap as
 *  `IssuesController.close`, QUESTIONS.md "001 T057": a repeat with a different body is not
 *  detected as `409 IDEMPOTENCY_CONFLICT`). */
export function requireIdempotencyKey(key: string | undefined): void {
  if (key === undefined || !UUID_PATTERN.test(key)) {
    throw new BadRequestException('Idempotency-Key header is required and must be a UUID');
  }
}
