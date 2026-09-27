import type { INestApplication } from '@nestjs/common';

/**
 * The tenant-isolation contract every endpoint test calls (`.claude/rules/backend-nestjs.md`:
 * "every new endpoint gets a tenant-isolation e2e test: another tenant's data returns 404").
 *
 * `gate-isolation` (012 T029) enumerates the committed OpenAPI document and greps e2e test
 * sources for a call to this function naming each path — a real function call is a much less
 * fragile signal than pattern-matching prose in a test's `it(...)` title.
 *
 * The body is not implemented here: it needs a second tenant's authenticated request context,
 * which does not exist until 001/002 land auth and tenant provisioning. Until then there is
 * nothing to call this against — every current endpoint (`/health`, `/ready`) is exempt because
 * neither is tenant-scoped — so an unimplemented body blocks nothing today and is a loud,
 * typed reminder rather than a silent gap the day the first tenant-scoped endpoint is added.
 */
export async function assertTenantIsolated(
  _app: INestApplication,
  _method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  _path: string,
): Promise<void> {
  throw new Error(
    'assertTenantIsolated has no implementation yet — it needs a second tenant context from 001/002',
  );
}
