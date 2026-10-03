export * from './domain/provenance.js';
export * from './domain/discovery-adapter.js';
export * from './domain/provenance-strength.js';
export * from './domain/node-identity.js';
export * from './domain/graph-concurrency-error.js';
export * from './domain/graph-node-repository.js';
export * from './domain/read-envelope.js';
export * from './domain/events.js';
export * from './domain/capabilities.js';
export * from './infrastructure/prisma-graph-node-repository.js';
// 004/master barrel collision (COMPONENT_TYPES/ComponentType/DEPLOYMENT_RUNTIME_KINDS/
// DeploymentRuntimeKind are identical to graph-vocabulary.js's, which master's own test pins to
// the Prisma enums and declares the one authority; GRAPH_EDGE_TYPES is the same list as its
// EDGE_TYPES under a different name). Re-exporting both would be TS2308. Phase 3's own code always
// imports closed-vocabularies.js directly (never through this barrel), so only the non-colliding
// helpers are re-exported here; full vocabulary consolidation is deferred.
export {
  isComponentType,
  isDeploymentRuntimeKind,
  isGraphEdgeType,
} from './domain/closed-vocabularies.js';
export * from './domain/confidence.js';
export * from './domain/proposed-payload.js';
export * from './domain/attribute-normalisation.js';
export * from './domain/proposal-digest.js';
export * from './domain/discovery-batch.js';
export * from './domain/confirmed-graph-snapshot.js';
export * from './domain/graph-fact-id.js';
export * from './domain/discovery-evidence.js';
export * from './domain/discovery-logger.js';
export * from './domain/source-outcome.js';
export * from './domain/node-key.js';
export * from './domain/diff-builder.js';
export * from './domain/discovery-repository.js';
export * from './application/collect-discovery.js';
export * from './application/start-discovery-run.js';
export * from './application/ingest-discovery-batch.js';
export * from './application/run-discovery.js';
export * from './infrastructure/prisma-discovery-repository.js';
export * from './domain/apply-draft-item.js';
export * from './domain/graph-audit-entry.js';
export * from './domain/node-kind-layer.js';
export * from './domain/draft-review-repository.js';
export * from './application/confirm-draft-items.js';
export * from './application/reject-draft-items.js';
export * from './infrastructure/prisma-draft-review-repository.js';
export * from './domain/graph-vocabulary.js';
export * from './domain/structural-edges.js';
export * from './domain/characteristics.js';
export * from './domain/kind-attributes.js';
export * from './domain/deployment-unit-placement.js';
export * from './domain/natural-key-collisions.js';
export * from './domain/graph-structure-repository.js';
export * from './infrastructure/prisma-graph-structure-repository.js';
export * from './domain/edge-observation.js';
export * from './infrastructure/prisma-edge-provenance-repository.js';
export * from './domain/edge-confidence.js';
export * from './domain/graph-read.js';
export * from './infrastructure/prisma-graph-read-repository.js';
export * from './domain/system-context.js';
export * from './application/queries/get-system-context.js';
export * from './infrastructure/prisma-system-context-repository.js';
export * from './domain/strongest-provenance.js';
export * from './infrastructure/graph-version-scope.js';
