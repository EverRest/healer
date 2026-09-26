/**
 * Tenant isolation (012 FR-048, 001 FR-015, constitution Security Model).
 *
 * The guarantee is not "remember to pass the tenant id". It is that a query which does
 * not carry one **cannot be constructed**: a repository accepts only a `TenantScoped`
 * value, the brand on that type is not exported, and the sole way to obtain one is
 * `scope()`, which takes a `TenantContext`. A plain object literal is not assignable,
 * so the omission is a compile error rather than a data leak
 * (`docs/patterns.md` — make the unsafe state unrepresentable).
 */

declare const tenantIdBrand: unique symbol;
declare const scopedBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: 'TenantId' };

/**
 * A filter that provably carries a tenant. Only `scope()` produces one; the brand is
 * declared, never exported, so no call site can assert its way past this.
 */
export type TenantScoped<W> = W & {
  readonly tenantId: TenantId;
  readonly [scopedBrand]: 'TenantScoped';
};

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The authenticated request context. Built from the auth result and nothing else —
 * never from a request body and never from a query parameter (FR-048). Frozen, because
 * a mutable tenant on a request-scoped object is one middleware away from a leak.
 */
export class TenantContext {
  private constructor(readonly tenantId: TenantId) {
    Object.freeze(this);
  }

  /** The only constructor. `claims` is what the authenticator verified, not what the caller sent. */
  static fromAuthenticatedClaims(claims: { readonly tenantId: string }): TenantContext {
    if (!UUID.test(claims.tenantId)) {
      throw new TenantIsolationError('authenticated claims carry no usable tenant identifier');
    }
    return new TenantContext(claims.tenantId as TenantId);
  }

  /** Test and seed construction. Named so that its appearance in production code is obvious. */
  static forTrustedInternalUse(tenantId: string): TenantContext {
    return TenantContext.fromAuthenticatedClaims({ tenantId });
  }
}

/** Attaches the tenant to a filter. The only producer of `TenantScoped`. */
export function scope<W extends object>(context: TenantContext, where: W): TenantScoped<W> {
  if ('tenantId' in where && where.tenantId !== context.tenantId) {
    // A caller that also supplied a tenant is either redundant or attempting a
    // cross-tenant read. Both are refused rather than silently overwritten.
    throw new TenantIsolationError('filter carries a tenant that is not the authenticated one');
  }
  return { ...where, tenantId: context.tenantId } as TenantScoped<W>;
}

/**
 * What a foreign identifier looks like from outside: not-found, never forbidden.
 * Forbidden confirms the row exists, which is itself the leak (001 SC-004).
 */
export class NotFoundError extends Error {
  constructor(readonly resource: string) {
    super(`${resource} not found`);
    this.name = 'NotFoundError';
  }
}
