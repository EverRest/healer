/**
 * Closed string vocabularies for the fields the wire types as plain `z.string()` because
 * `@healer/boundary-contract` has zero workspace dependencies by design (ADR 0001) and cannot
 * import this package's domain enums. Ingestion validates those fields against these lists
 * (graph-contract.md §3, 004 Phase 3 plan "Ingestion rules") — a value outside the list is
 * `schema_rejected`, the same outcome boundary-contract's own `.strict()` gives an unknown key.
 * Mirrors `prisma/schema.prisma`'s `component_type` / `deployment_runtime_kind` /
 * `graph_edge_type` enums (DB mirror, same convention as `ProvenanceClass`'s comment in
 * `provenance.ts`) — the domain package is the TypeScript authority, the migration is its mirror.
 */

export const COMPONENT_TYPES = [
  'service',
  'library',
  'frontend',
  'worker',
  'job',
  'datastore',
  'external',
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];
export function isComponentType(value: string): value is ComponentType {
  return (COMPONENT_TYPES as readonly string[]).includes(value);
}

export const DEPLOYMENT_RUNTIME_KINDS = [
  'container',
  'function',
  'vm',
  'static_site',
  'managed_service',
] as const;
export type DeploymentRuntimeKind = (typeof DEPLOYMENT_RUNTIME_KINDS)[number];
export function isDeploymentRuntimeKind(value: string): value is DeploymentRuntimeKind {
  return (DEPLOYMENT_RUNTIME_KINDS as readonly string[]).includes(value);
}

export const GRAPH_EDGE_TYPES = [
  'depends_on',
  'calls',
  'deploys',
  'contains',
  'implements',
  'exposes',
  'serves_feature',
  'built_from',
] as const;
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];
export function isGraphEdgeType(value: string): value is GraphEdgeType {
  return (GRAPH_EDGE_TYPES as readonly string[]).includes(value);
}
