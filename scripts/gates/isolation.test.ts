import { describe, expect, it } from 'vitest';
import { findUncoveredEndpoints } from './isolation.mjs';

const openapi = {
  paths: {
    '/health': { get: {} },
    '/ready': { get: {} },
    '/issues/{id}': { get: {}, delete: {} },
  },
};

describe('gate-isolation (012 T029, FR-013, quickstart 10)', () => {
  it('exempts /health and /ready — neither is tenant-scoped', () => {
    const uncovered = findUncoveredEndpoints(openapi, []);
    expect(uncovered).not.toContain(expect.stringContaining('/health'));
    expect(uncovered).not.toContain(expect.stringContaining('/ready'));
  });

  it('fails when a tenant-scoped endpoint has no isolation test', () => {
    const uncovered = findUncoveredEndpoints(openapi, []);
    expect(uncovered).toEqual(['GET /issues/:id', 'DELETE /issues/:id']);
  });

  it('is satisfied by a real assertTenantIsolated call naming the route', () => {
    const uncovered = findUncoveredEndpoints(openapi, [
      "assertTenantIsolated(app, 'GET', '/issues/:id');",
    ]);
    expect(uncovered).toEqual(['DELETE /issues/:id']);
  });

  it('matches an OpenAPI {param} path against a test written with :param', () => {
    const uncovered = findUncoveredEndpoints(openapi, [
      "await assertTenantIsolated(app, 'DELETE', '/issues/:id');",
    ]);
    expect(uncovered).toEqual(['GET /issues/:id']);
  });

  it('does not count a commented-out assertTenantIsolated call as coverage', () => {
    const uncovered = findUncoveredEndpoints(openapi, [
      "// assertTenantIsolated(app, 'GET', '/issues/:id');",
      "/* assertTenantIsolated(app, 'DELETE', '/issues/:id'); */",
    ]);
    expect(uncovered).toEqual(['GET /issues/:id', 'DELETE /issues/:id']);
  });

  it('does not count a call inside it.skip as coverage — a disabled test never actually runs it', () => {
    const uncovered = findUncoveredEndpoints(openapi, [
      "it.skip('is isolated', async () => { await assertTenantIsolated(app, 'GET', '/issues/:id'); });",
      "await assertTenantIsolated(app, 'DELETE', '/issues/:id');",
    ]);
    expect(uncovered).toEqual(['GET /issues/:id']);
  });

  it('is satisfied by a real assertTenantScopedEnqueue call naming the route (001 T019)', () => {
    const uncovered = findUncoveredEndpoints(openapi, [
      "await assertTenantScopedEnqueue(app, 'GET', '/issues/:id', { tenantA, tenantB, tenantHeader, expectStatus, bodyFor, tenantIdFor });",
    ]);
    expect(uncovered).toEqual(['DELETE /issues/:id']);
  });

  it('is satisfied by a real assertTenantIsolatedList call naming the route (001 T040)', () => {
    const uncovered = findUncoveredEndpoints(openapi, [
      "await assertTenantIsolatedList(app, 'GET', '/issues/:id', { tenantA, tenantB, tenantHeader, createUnderA, responseContainsMarker });",
    ]);
    expect(uncovered).toEqual(['DELETE /issues/:id']);
  });

  it('does not count a call inside describe.skip as coverage', () => {
    const uncovered = findUncoveredEndpoints(openapi, [
      `describe.skip('issues', () => {
         it('is isolated', async () => {
           await assertTenantIsolated(app, 'GET', '/issues/:id');
         });
       });`,
    ]);
    expect(uncovered).toEqual(['GET /issues/:id', 'DELETE /issues/:id']);
  });
});
