import type { ComponentType, DeploymentRuntimeKind, GraphEdgeType } from './closed-vocabularies.js';

/** Node kinds discovery proposes in Phase 3 (004 Phase 3 plan). `endpoint`/`feature`/`flow`/
 *  `external` are later phases' concern (T051 external nodes, T081 product layer). */
export const DISCOVERY_NODE_KINDS = ['component', 'deployment_unit', 'repository'] as const;
export type DiscoveryNodeKind = (typeof DISCOVERY_NODE_KINDS)[number];

/** "Endpoints of an edge are carried as `{ nodeKind, naturalKey }`" (plan, resolved to ids at
 *  confirm time — T026, sub-batch B). */
export interface NodeRef {
  readonly nodeKind: DiscoveryNodeKind;
  readonly naturalKey: string;
}

export interface ComponentAttributes {
  readonly componentType: ComponentType;
  readonly characteristics: readonly string[];
  readonly ownerRef: string | null;
}

export interface DeploymentUnitAttributes {
  readonly environment: string;
  readonly runtimeKind: DeploymentRuntimeKind;
  readonly runtimeRef: string;
  readonly currentVersion: string | null;
  readonly lastDeployedAt: string | null;
}

/** Matches `repository_attr`'s columns exactly (data-model.md) — deliberately no `headSha`: the
 *  confirmed graph has no column for it (it is not an attribute of the repository, it is a fact
 *  about the repository's current state that changes every commit, same volatility class as
 *  `currentVersion`/`lastDeployedAt` — proposal-digest.ts excludes it from the digest, and this
 *  interface excludes it from the comparison entirely by never carrying it past the wire shape). */
export interface RepositoryAttributes {
  readonly vcs: 'gitlab';
  readonly projectRef: string;
  readonly defaultBranch: string;
}

export type NodeAttributes = ComponentAttributes | DeploymentUnitAttributes | RepositoryAttributes;

/** The closed shape `draft_item.proposed` takes per `op` (data-model.md, plan "The draft as a
 *  diff") — no free-form customer text beyond identifiers/names, closed by construction: nothing
 *  outside this module builds one. */
export type ProposedPayload =
  | {
      readonly op: 'add_node';
      readonly nodeKind: DiscoveryNodeKind;
      readonly naturalKey: string;
      readonly name: string;
      readonly attributes: NodeAttributes;
    }
  | {
      readonly op: 'modify_attributes';
      readonly nodeKind: DiscoveryNodeKind;
      readonly naturalKey: string;
      readonly name: string;
      readonly attributes: NodeAttributes;
    }
  | {
      readonly op: 'add_edge';
      readonly from: NodeRef;
      readonly to: NodeRef;
      readonly edgeType: GraphEdgeType;
      readonly layer: 'code' | 'runtime' | 'product';
    }
  | { readonly op: 'mark_removed'; readonly target: { readonly kind: 'node' } & NodeRef }
  | {
      readonly op: 'mark_removed';
      readonly target: { readonly kind: 'edge' } & {
        readonly from: NodeRef;
        readonly to: NodeRef;
        readonly edgeType: GraphEdgeType;
        readonly layer: 'code' | 'runtime' | 'product';
      };
    };

export function sortedCharacteristics(characteristics: readonly string[]): readonly string[] {
  return [...characteristics].sort();
}
