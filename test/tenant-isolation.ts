import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/**
 * The tenant-isolation contract every endpoint test calls (`.claude/rules/backend-nestjs.md`:
 * "every new endpoint gets a tenant-isolation e2e test: another tenant's data returns 404").
 *
 * `gate-isolation` (012 T029) enumerates the committed OpenAPI document and greps e2e test
 * sources for a call to this function naming each path — a real function call is a much less
 * fragile signal than pattern-matching prose in a test's `it(...)` title. The `path` argument
 * stays the literal `:param` template (never a real id substituted by the caller) so the gate's
 * static text match keeps working; this function does the substitution itself, at runtime,
 * against the real id `createUnderTenant` returns.
 *
 * **Fixed (review finding, post-T044)**: the previous version fired one request under a random
 * tenant and asserted 404 — which this codebase's own `findById` P2023 handling (C-55) already
 * guarantees for a syntactically invalid id, with or without any tenant scoping at all. Every
 * caller passes the literal `:issueId`-shaped placeholder as `path` (C-54, for `gate-isolation`'s
 * benefit), so the "resource" being requested was never real, and this proved nothing about
 * whether the query itself is tenant-scoped — a repository with `tenantId` silently dropped from
 * its `WHERE` clause would have passed every one of these tests unchanged. Now: a real resource is
 * created under tenant A, tenant A's own request for it is confirmed to succeed first (otherwise
 * the rest proves nothing), and only then is the identical request repeated under a fresh,
 * guaranteed-different tenant B and asserted 404 — never 403, which would itself leak that the
 * resource exists (SC-004).
 */
export async function assertTenantIsolated(
  app: INestApplication,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  config: {
    readonly tenantA: string;
    readonly tenantB: string;
    readonly tenantHeader: string;
    /** Creates the resource under `tenantA` and returns its real id, substituted for the path's
     *  `:param` placeholder before the request is actually sent. */
    createUnderTenant(tenantId: string): Promise<string>;
    /** The status tenant A's own request for its own resource should return. Default 200. */
    ownRequestStatus?: number;
    /** Extra headers and a body for a mutation that will not even reach its lookup without them
     *  (001 T057: `POST /issues/{id}/close` needs an idempotency key, an actor and a reason).
     *  Sent identically for both tenants, so the only difference between the two requests is
     *  the tenant. */
    readonly requestHeaders?: Record<string, string>;
    readonly body?: unknown;
  },
): Promise<void> {
  const httpMethod = method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
  const realId = await config.createUnderTenant(config.tenantA);
  const realPath = path.replace(/:[^/]+/, encodeURIComponent(realId));
  const send = (tenant: string) => {
    const pending = request(app.getHttpServer())
      [httpMethod](realPath)
      .set({ ...config.requestHeaders, [config.tenantHeader]: tenant });
    return config.body === undefined ? pending : pending.send(config.body as object);
  };

  await send(config.tenantA).expect(config.ownRequestStatus ?? 200);
  await send(config.tenantB).expect(404);
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

/**
 * The tenant-isolation contract for a list endpoint (001 T040) — neither of the two shapes above
 * fits: a list always returns 200 with no id to look up and nothing enqueued to trace by marker.
 * This function itself performs the request against `(app, method, path)`, same as
 * `assertTenantScopedEnqueue` (see that review finding above) — a helper whose gate-recognized
 * arguments it never actually used would prove nothing about what ran. Proof here is that a
 * resource created under tenant A appears in the list returned for tenant A and never in the one
 * returned for tenant B.
 */
export async function assertTenantIsolatedList(
  app: INestApplication,
  method: 'GET',
  path: string,
  config: {
    readonly tenantA: string;
    readonly tenantB: string;
    readonly tenantHeader: string;
    /** Creates a resource under tenant A and returns a marker identifying it in a list response. */
    createUnderA(): Promise<string>;
    /** Whether `marker` appears in this list response's body. */
    responseContainsMarker(body: unknown, marker: string): boolean;
  },
): Promise<void> {
  const marker = await config.createUnderA();
  const httpMethod = method.toLowerCase() as 'get';

  const responseA = await request(app.getHttpServer())
    [httpMethod](path)
    .set(config.tenantHeader, config.tenantA);
  if (!config.responseContainsMarker(responseA.body, marker)) {
    throw new Error(
      `assertTenantIsolatedList: ${marker} does not even appear in its own tenant's list`,
    );
  }

  const responseB = await request(app.getHttpServer())
    [httpMethod](path)
    .set(config.tenantHeader, config.tenantB);
  if (config.responseContainsMarker(responseB.body, marker)) {
    throw new Error(
      `assertTenantIsolatedList: ${marker} leaked into tenant ${config.tenantB}'s list`,
    );
  }
}
