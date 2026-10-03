import type { CollectorDeclaration } from './collector-registry.js';

/**
 * `context.collector_registration` is global (R-12: which collectors exist is a product fact), so
 * unlike every tenant-data repository this one takes no `TenantScoped` argument.
 */
export interface CollectorRegistrationRepository {
  /** Upserts one row per declaration; idempotent, safe to run at every boot. */
  syncCollectorRegistry(registry: readonly CollectorDeclaration[]): Promise<void>;
}
