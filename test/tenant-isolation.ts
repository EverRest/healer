import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/**
 * The tenant-isolation contract every endpoint test calls (`.claude/rules/backend-nestjs.md`:
 * "every new endpoint gets a tenant-isolation e2e test: another tenant's data returns 404").
 *
 * `gate-isolation` (012 T029) enumerates the committed OpenAPI document and greps e2e test
 * sources for a call to this function naming each path — a real function call is a much less
 * fragile signal than pattern-matching prose in a test's `it(...)` title.
 *
 * Implemented now (001 T031 review): the earlier comment held this needed "a second tenant's
 * authenticated request context, which does not exist until 001/002 land auth" — but every
 * endpoint in this codebase, including every one built since, resolves tenant identity from a
 * bare, unverified `X-Tenant-Id` header (`TenantContext.forTrustedInternalUse`, the same stub
 * `assertTenantScopedEnqueue` already exercises this way). A "second tenant" under that stub is
 * just a second header value — no real auth is needed to prove a resource created under tenant A
 * is invisible to a request naming tenant B, only that the query itself is scoped, which is
 * exactly what this proves. The caller creates whatever the concrete `path` names under a real
 * tenant of its own choosing; this sends the same request under a fresh, guaranteed-different
 * one and asserts 404 — never 403, which would itself leak that the resource exists (SC-004).
 */
export async function assertTenantIsolated(
  app: INestApplication,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
): Promise<void> {
  const httpMethod = method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
  await request(app.getHttpServer())[httpMethod](path).set('X-Tenant-Id', randomUUID()).expect(404);
}

/**
 * The tenant-isolation contract for a write-only, fire-and-forget endpoint (001 T019) —
 * `assertTenantIsolated`'s "create as A, read as B, expect 404" shape does not apply to a route
 * whose only response is an accepted count, with nothing to read back through the API itself.
 *
 * This function itself performs the request against `(app, method, path)` — a review finding on
 * the first version of this helper: it took `_app`/`_method`/`_path` but never used them, only a
 * caller-supplied `writeAs` that could point anywhere, so `gate-isolation` recognizing the call
 * proved nothing about what the call actually did. Naming the route and exercising it are now the
 * same three arguments.
 *
 * Proof here is that a value scoped to tenant A can never be observed landing under tenant B: a
 * unique marker goes in each tenant's request body, and the caller supplies how to look up which
 * tenant a marker actually landed under (e.g. a queued job's own `tenantId` field, found by the
 * marker embedded in its payload) — a real assertion, not a presence check that a filter could
 * trivially satisfy regardless of an actual cross-tenant leak.
 *
 * `gate-isolation` (012 T029) recognizes a call to this the same way it recognizes
 * `assertTenantIsolated` — naming the endpoint is what the gate checks.
 */
export async function assertTenantScopedEnqueue(
  app: INestApplication,
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  config: {
    readonly tenantA: string;
    readonly tenantB: string;
    readonly tenantHeader: string;
    readonly expectStatus: number;
    bodyFor(marker: string): unknown;
    tenantIdFor(marker: string): Promise<string | undefined>;
    /** Extra per-marker headers (e.g. an idempotency key derived from the marker itself). */
    headersFor?(marker: string): Record<string, string>;
  },
): Promise<void> {
  const markerA = `isolation-check-a-${randomUUID()}`;
  const markerB = `isolation-check-b-${randomUUID()}`;
  const httpMethod = method.toLowerCase() as 'post' | 'patch' | 'put';
  const headersFor = config.headersFor ?? (() => ({}));

  await request(app.getHttpServer())
    [httpMethod](path)
    .set({ [config.tenantHeader]: config.tenantA, ...headersFor(markerA) })
    .send(config.bodyFor(markerA))
    .expect(config.expectStatus);
  await request(app.getHttpServer())
    [httpMethod](path)
    .set({ [config.tenantHeader]: config.tenantB, ...headersFor(markerB) })
    .send(config.bodyFor(markerB))
    .expect(config.expectStatus);

  const landedA = await config.tenantIdFor(markerA);
  const landedB = await config.tenantIdFor(markerB);

  if (landedA !== config.tenantA) {
    throw new Error(
      `assertTenantScopedEnqueue: write marked ${markerA} landed under tenant ${landedA}, expected ${config.tenantA}`,
    );
  }
  if (landedB !== config.tenantB) {
    throw new Error(
      `assertTenantScopedEnqueue: write marked ${markerB} landed under tenant ${landedB}, expected ${config.tenantB}`,
    );
  }
}
