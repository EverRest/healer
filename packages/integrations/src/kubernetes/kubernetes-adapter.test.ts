import { describe, expect, it } from 'vitest';
import { kubernetesAdapter } from './kubernetes-adapter.js';

describe('kubernetesAdapter (T003, FR-020, contracts/graph-contract.md §3)', () => {
  it('fixes layer and provenance to what the runtime source justifies, with no field to override', () => {
    expect(kubernetesAdapter.key).toBe('kubernetes');
    expect(kubernetesAdapter.version).toBe('0.1.0');
    expect(kubernetesAdapter.layer).toBe('runtime');
    expect(kubernetesAdapter.provenance).toBe('derived_from_runtime');
  });

  it('collects the empty envelope shape without throwing', async () => {
    await expect(
      kubernetesAdapter.collect({ tenantId: 'tenant-1', runnerId: 'runner-1' }),
    ).resolves.toEqual({
      componentCandidates: [],
      deploymentUnitCandidates: [],
      dependencyObservations: [],
      repositoryRefs: [],
    });
  });

  it('honours an already-aborted signal rather than ignoring it', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      kubernetesAdapter.collect({ tenantId: 'tenant-1', runnerId: 'runner-1', signal: controller.signal }),
    ).rejects.toThrow();
  });
});
