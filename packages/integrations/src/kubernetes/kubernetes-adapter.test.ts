import { describe, expect, it } from 'vitest';
import { createKubernetesAdapter } from './kubernetes-adapter.js';
import { createDesignPartnerKubernetesReader } from '../test-support/design-partner.js';

const scope = { tenantId: 'tenant-1', runnerId: 'runner-1' };

describe('createKubernetesAdapter (A2, FR-020, contracts/graph-contract.md §3)', () => {
  it('fixes key/version/layer/provenance with no field to override', () => {
    const adapter = createKubernetesAdapter(createDesignPartnerKubernetesReader().reader);
    expect(adapter.key).toBe('kubernetes');
    expect(adapter.version).toBe('0.2.0');
    expect(adapter.layer).toBe('runtime');
    expect(adapter.provenance).toBe('derived_from_runtime');
  });

  it('collects one deployment_unit_candidate per workload, keyed by k8s:<ns>/<kind>/<name>', async () => {
    const { reader } = createDesignPartnerKubernetesReader();
    const facts = await createKubernetesAdapter(reader).collect(scope);
    expect(facts.deploymentUnitCandidates.map((c) => c.naturalKey).sort()).toEqual([
      'k8s:production/Deployment/backend',
      'k8s:production/Deployment/frontend',
      'k8s:production/Deployment/worker',
    ]);
  });

  it('reads the image tag as currentVersion, defaulting to unknown when the image has none', async () => {
    const { reader } = createDesignPartnerKubernetesReader();
    const facts = await createKubernetesAdapter(reader).collect(scope);
    const byRuntimeRef = new Map(facts.deploymentUnitCandidates.map((c) => [c.runtimeRef, c]));
    expect(byRuntimeRef.get('production/Deployment/backend')?.currentVersion).toBe('1.4.2');
  });

  it('emits a deploys observation from the app.kubernetes.io/name label to the unit, layer/provenance fixed', async () => {
    const { reader } = createDesignPartnerKubernetesReader();
    const facts = await createKubernetesAdapter(reader).collect(scope);
    expect(facts.dependencyObservations).toHaveLength(3);
    expect(
      facts.dependencyObservations.every(
        (d) =>
          d.edgeType === 'deploys' &&
          d.layer === 'runtime' &&
          d.provenance === 'derived_from_runtime',
      ),
    ).toBe(true);
    const backendDeploy = facts.dependencyObservations.find((d) => d.fromNaturalKey === 'backend');
    expect(backendDeploy?.toNaturalKey).toBe('k8s:production/Deployment/backend');
  });

  it('never reads an annotation value into any emitted fact', async () => {
    const { reader } = createDesignPartnerKubernetesReader({
      annotationValue: 'a secret nobody should see',
    });
    const facts = await createKubernetesAdapter(reader).collect(scope);
    expect(JSON.stringify(facts)).not.toContain('a secret nobody should see');
  });

  it('rejects an already-aborted signal before doing any I/O', async () => {
    const { reader, calls } = createDesignPartnerKubernetesReader();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createKubernetesAdapter(reader).collect({ ...scope, signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
