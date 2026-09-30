import { describe, expect, it } from 'vitest';
import { otelAdapter } from './otel-adapter.js';

describe('otelAdapter (T003, FR-020, contracts/graph-contract.md §3)', () => {
  it('fixes layer and provenance to what trace observation justifies, with no field to override', () => {
    expect(otelAdapter.key).toBe('otel');
    expect(otelAdapter.version).toBe('0.1.0');
    expect(otelAdapter.layer).toBe('runtime');
    expect(otelAdapter.provenance).toBe('derived_from_trace');
  });

  it('collects the empty envelope shape without throwing', async () => {
    await expect(
      otelAdapter.collect({ tenantId: 'tenant-1', runnerId: 'runner-1' }),
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
      otelAdapter.collect({
        tenantId: 'tenant-1',
        runnerId: 'runner-1',
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
