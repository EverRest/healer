import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TenantContext, TenantIsolationError } from '@healer/shared';

/** Shared by every `/discovery/*` controller — same deliberate, TODO-flagged stub-auth pattern as
 *  `IssuesController.resolveTenant`/`policy-http.ts`'s `resolveTenant` (001 T019): no credential
 *  is verified yet. */
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

/** `Idempotency-Key` — same convention as `policy-http.ts`'s `requireIdempotencyKey`: required
 *  and shape-validated, not stored (same known gap, QUESTIONS.md "001 T057"). */
export function requireIdempotencyKey(key: string | undefined): void {
  if (key === undefined || !UUID_PATTERN.test(key)) {
    throw new BadRequestException('Idempotency-Key header is required and must be a UUID');
  }
}

/**
 * Fail-closed refusal for the graph confirm/reject routes (FR-010, SC-002), by design, not a
 * feature flag. A caller cannot be verified as a human yet: no credential or capability registry
 * exists (`capabilities.ts`), and every header this API trusts is caller-asserted (`X-Tenant-Id`,
 * `X-Actor-Id`). Trusting an `X-Actor-Type: human` header here would let any client confirm graph
 * edges. So these routes refuse unconditionally until a verified human credential is wired up
 * (QUESTIONS.md, reconciliation batch: decision recorded for Pavlo to revisit). The application
 * commands `confirmDraftItems`/`rejectDraftItems` are untouched and still take a `GraphReviewActor`.
 */
export function refuseUnverifiedGraphReview(operation: string): never {
  throw new ForbiddenException({
    code: 'HUMAN_CREDENTIAL_REQUIRED',
    message: `${operation} requires a verified human credential; none is configured yet`,
  });
}
