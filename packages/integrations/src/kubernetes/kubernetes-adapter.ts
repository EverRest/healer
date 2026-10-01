import type { DependencyObservation, DeploymentUnitCandidate } from '@healer/boundary-contract';
import type { DiscoveryAdapter, DiscoveryFacts, DiscoveryScope } from '@healer/domain-architecture';

/**
 * Read-only seam a runner-side Kubernetes client plugs into later (012-runner; no credentials or
 * config exist yet in this batch — see QUESTIONS.md "004 Phase 3 — adapter collection (A2)"). Every
 * method is read-only by construction: there is no write method on this interface to call.
 */
export interface KubernetesWorkload {
  readonly namespace: string;
  readonly kind: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly image: string;
  readonly lastDeployedAt?: string;
}

export interface KubernetesReader {
  listWorkloads(): Promise<readonly KubernetesWorkload[]>;
}

const KUBERNETES_ADAPTER_KEY = 'kubernetes';
const KUBERNETES_ADAPTER_VERSION = '0.2.0';
const KUBERNETES_LAYER = 'runtime';
const KUBERNETES_PROVENANCE = 'derived_from_runtime';
const APP_NAME_LABEL = 'app.kubernetes.io/name';

function imageTag(image: string): string {
  const lastSlash = image.lastIndexOf('/');
  const afterSlash = lastSlash === -1 ? image : image.slice(lastSlash + 1);
  const colon = afterSlash.lastIndexOf(':');
  if (colon === -1) return 'unknown';
  return afterSlash.slice(colon + 1) || 'unknown';
}

function toDeploymentUnitCandidate(workload: KubernetesWorkload): DeploymentUnitCandidate {
  const runtimeRef = `${workload.namespace}/${workload.kind}/${workload.name}`;
  const candidate: DeploymentUnitCandidate = {
    kind: 'deployment_unit_candidate',
    naturalKey: `k8s:${runtimeRef}`,
    environment: workload.namespace,
    runtimeKind: 'container',
    runtimeRef,
    currentVersion: imageTag(workload.image),
  };
  return workload.lastDeployedAt
    ? { ...candidate, lastDeployedAt: workload.lastDeployedAt }
    : candidate;
}

/** `null` when the workload carries no `app.kubernetes.io/name` label to deploy from. Annotations
 *  are never read here — the type is not even destructured for them (FR-026). */
function toDeploysObservation(
  workload: KubernetesWorkload,
  unitNaturalKey: string,
  observedAt: string,
): DependencyObservation | null {
  const componentNaturalKey = workload.labels[APP_NAME_LABEL];
  if (!componentNaturalKey) return null;
  return {
    kind: 'dependency_observation',
    fromNaturalKey: componentNaturalKey,
    toNaturalKey: unitNaturalKey,
    edgeType: 'deploys',
    layer: KUBERNETES_LAYER,
    provenance: KUBERNETES_PROVENANCE,
    observationCount: 1,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    windowSeconds: 0,
  };
}

/**
 * Deployment-unit discovery over Kubernetes workloads (FR-020, contracts/graph-contract.md §3).
 * `provenance`/`layer` are fixed by `KUBERNETES_LAYER`/`KUBERNETES_PROVENANCE` above, reused for
 * both the frozen adapter fields and every emitted `dependency_observation`.
 */
export function createKubernetesAdapter(reader: KubernetesReader) {
  return Object.freeze({
    key: KUBERNETES_ADAPTER_KEY,
    version: KUBERNETES_ADAPTER_VERSION,
    layer: KUBERNETES_LAYER,
    provenance: KUBERNETES_PROVENANCE,
    async collect(scope: DiscoveryScope): Promise<DiscoveryFacts> {
      scope.signal?.throwIfAborted();
      const workloads = await reader.listWorkloads();
      scope.signal?.throwIfAborted();

      const observedAt = new Date().toISOString();
      const deploymentUnitCandidates: DeploymentUnitCandidate[] = [];
      const dependencyObservations: DependencyObservation[] = [];

      for (const workload of workloads) {
        const candidate = toDeploymentUnitCandidate(workload);
        deploymentUnitCandidates.push(candidate);
        const observation = toDeploysObservation(workload, candidate.naturalKey, observedAt);
        if (observation) dependencyObservations.push(observation);
      }

      return {
        componentCandidates: [],
        deploymentUnitCandidates,
        dependencyObservations,
        repositoryRefs: [],
        collectionGaps: [],
      };
    },
  } as const) satisfies DiscoveryAdapter;
}
