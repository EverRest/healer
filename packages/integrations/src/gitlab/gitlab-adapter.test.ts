import { describe, expect, it } from 'vitest';
import { gitlabAdapter } from './gitlab-adapter.js';

describe('gitlabAdapter (T003, FR-020, contracts/graph-contract.md §3)', () => {
  it('fixes layer and provenance to what the code-layer source justifies, with no field to override', () => {
    expect(gitlabAdapter.key).toBe('gitlab');
    expect(gitlabAdapter.version).toBe('0.1.0');
    expect(gitlabAdapter.layer).toBe('code');
    expect(gitlabAdapter.provenance).toBe('derived_from_code');
  });

  it('collects the empty envelope shape without throwing', async () => {
    await expect(
      gitlabAdapter.collect({ tenantId: 'tenant-1', runnerId: 'runner-1' }),
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
      gitlabAdapter.collect({ tenantId: 'tenant-1', runnerId: 'runner-1', signal: controller.signal }),
    ).rejects.toThrow();
  });
});
