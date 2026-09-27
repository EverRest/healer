// The single authority for R-11's risk-weighted, 95%-floor source directories — referenced by
// both vitest.config.ts's coverage thresholds and gate-coverage-completeness, so the two cannot
// silently name a different set (a closed list has exactly one authority).
export const RISK_WEIGHTED_DIRS = [
  'packages/domain/policy',
  'packages/domain/evidence',
  'packages/shared/src/tenancy',
  'packages/agents/src/output',
];
