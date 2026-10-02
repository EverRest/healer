import type { DiscoveryNodeKind } from './proposed-payload.js';
import type { GraphLayer } from './provenance.js';

/**
 * `graph_node.layer` is `NOT NULL` (T006), but no discovery wire shape carries a `layer` field for
 * a `component_candidate` / `deployment_unit_candidate` / `repository_ref` (graph-contract.md §3 —
 * only `dependency_observation` is adapter-layer-stamped, since only edges cross between layers).
 * The three discovery node kinds map to a layer structurally, not per observation: a component or
 * repository is code-layer by definition (FR-004), a deployment unit is runtime-layer by
 * definition. Stamped once, here, at confirmation (T026) — the one place a `graph_node` row is
 * first written in this codebase.
 */
export const DISCOVERY_NODE_KIND_LAYER: Readonly<Record<DiscoveryNodeKind, GraphLayer>> = {
  component: 'code',
  deployment_unit: 'runtime',
  repository: 'code',
};
