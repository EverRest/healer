/**
 * The closed lists the graph's kinds and attribute enums are drawn from — ONE authority (AGENTS.md
 * "a closed list has exactly one authority"). `prisma/schema.prisma` mirrors them as database
 * enums (a migration is the only way to widen them, deliberately); `graph-vocabulary.test.ts`
 * reads the schema and fails when the two disagree, which is the mechanism that refuses to let
 * the copies drift. Nothing here describes a system's architecture as a style (FR-001, D-09).
 */
export const NODE_KINDS = [
  'component',
  'deployment_unit',
  'repository',
  'endpoint',
  'feature',
  'flow',
  'external',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_TYPES = [
  'depends_on',
  'calls',
  'deploys',
  'contains',
  'implements',
  'exposes',
  'serves_feature',
  'built_from',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

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

export const DEPLOYMENT_RUNTIME_KINDS = [
  'container',
  'function',
  'vm',
  'static_site',
  'managed_service',
] as const;
export type DeploymentRuntimeKind = (typeof DEPLOYMENT_RUNTIME_KINDS)[number];

export const REPOSITORY_VCS = ['gitlab'] as const;
export type RepositoryVcs = (typeof REPOSITORY_VCS)[number];

export const ENDPOINT_PROTOCOLS = ['http', 'grpc', 'event', 'cli'] as const;
export type EndpointProtocol = (typeof ENDPOINT_PROTOCOLS)[number];
