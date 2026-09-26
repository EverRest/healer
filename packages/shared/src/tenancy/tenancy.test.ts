import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  NotFoundError,
  TenantContext,
  TenantIsolationError,
  type TenantScoped,
  scope,
} from './index.js';

const TENANT = '0193a1f0-0000-7000-8000-000000000001';
const OTHER = '0193a1f0-0000-7000-8000-000000000002';

// A repository, as every repository in the product is shaped: it accepts only a scoped filter.
function findIssues(where: TenantScoped<{ state?: string }>): TenantScoped<{ state?: string }> {
  return where;
}

describe('tenant scoping', () => {
  it('attaches the authenticated tenant to the filter', () => {
    const ctx = TenantContext.fromAuthenticatedClaims({ tenantId: TENANT });
    expect(findIssues(scope(ctx, { state: 'open' }))).toEqual({
      state: 'open',
      tenantId: TENANT,
    });
  });

  it('refuses a filter carrying a different tenant rather than overwriting it', () => {
    const ctx = TenantContext.fromAuthenticatedClaims({ tenantId: TENANT });
    expect(() => scope(ctx, { tenantId: OTHER })).toThrow(TenantIsolationError);
  });

  it('refuses claims with no usable tenant identifier', () => {
    expect(() => TenantContext.fromAuthenticatedClaims({ tenantId: 'tenant-1' })).toThrow(
      TenantIsolationError,
    );
  });

  it('cannot be built from an unscoped object literal — the omission is a type error', () => {
    // @ts-expect-error a filter without a proven tenant is not assignable to TenantScoped
    findIssues({ state: 'open' });
    // @ts-expect-error nor is a hand-written tenantId, which is the mistake this brand exists for
    findIssues({ state: 'open', tenantId: OTHER });
    expectTypeOf(scope).parameter(0).toEqualTypeOf<TenantContext>();
  });

  it('reports a foreign identifier as not-found, never as forbidden', () => {
    const error = new NotFoundError('issue');
    expect(error.message).toContain('not found');
    expect(error.message).not.toContain('forbidden');
  });
});
