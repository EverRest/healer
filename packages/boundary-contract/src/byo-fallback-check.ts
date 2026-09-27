/**
 * The BYO fallback trap, continuously checked (012 T070, FR-046, R-08, data-model invariant).
 * `tenant_provider_config.fallback_scope` (schema.prisma) already makes cross-boundary fallback
 * unrepresentable at write time by being a single-value enum; this is the read-side check that
 * nothing slipped past it — an `agent_run` for a `customer_byo` tenant used a provider other than
 * the one the tenant configured, which is what a silent fallback to a Healer-provided key would
 * look like from the data alone. The actual scheduled query against `agent_run` and
 * `tenant_provider_config` is a repository concern that doesn't exist yet (same gap as T042).
 */
export interface TenantProviderConfigRow {
  readonly tenantId: string;
  readonly mode: 'healer_provided' | 'customer_byo';
  readonly provider: string;
}

export interface AgentRunRow {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
}

export function findByoFallbackViolations(
  tenantConfigs: readonly TenantProviderConfigRow[],
  agentRuns: readonly AgentRunRow[],
): string[] {
  const byoProviderByTenant = new Map(
    tenantConfigs.filter((c) => c.mode === 'customer_byo').map((c) => [c.tenantId, c.provider]),
  );
  const violations: string[] = [];
  for (const run of agentRuns) {
    const expected = byoProviderByTenant.get(run.tenantId);
    if (expected !== undefined && run.provider !== expected) {
      violations.push(
        `agent_run ${run.id}: BYO tenant ${run.tenantId} configured for ${expected} but the run used ${run.provider}`,
      );
    }
  }
  return violations;
}
