import { describe, expect, it } from 'vitest';
import { createOtelAdapter } from './otel-adapter.js';
import { createDesignPartnerOtelReader } from '../test-support/design-partner.js';

const scope = { tenantId: 'tenant-1', runnerId: 'runner-1' };

describe('createOtelAdapter (A2, FR-020, contracts/graph-contract.md §3)', () => {
  it('fixes key/version/layer/provenance with no field to override', () => {
    const adapter = createOtelAdapter(createDesignPartnerOtelReader().reader);
    expect(adapter.key).toBe('otel');
    expect(adapter.version).toBe('0.2.0');
    expect(adapter.layer).toBe('runtime');
    expect(adapter.provenance).toBe('derived_from_trace');
  });

  it('emits one calls observation per service edge, observationCount = spanCount', async () => {
    const { reader } = createDesignPartnerOtelReader();
    const facts = await createOtelAdapter(reader).collect(scope);
    const byPair = new Map(
      facts.dependencyObservations.map((d) => [`${d.fromNaturalKey}->${d.toNaturalKey}`, d]),
    );
    expect(byPair.get('frontend->backend')?.observationCount).toBe(420);
    expect(byPair.get('worker->backend')?.observationCount).toBe(133);
    expect(
      facts.dependencyObservations.every(
        (d) =>
          d.edgeType === 'calls' && d.layer === 'runtime' && d.provenance === 'derived_from_trace',
      ),
    ).toBe(true);
  });

  it('passes its window to the reader and stamps it on every observation', async () => {
    const { reader, calls } = createDesignPartnerOtelReader();
    const facts = await createOtelAdapter(reader, 3600).collect(scope);
    expect(calls).toEqual([{ method: 'serviceEdges', args: [3600] }]);
    expect(facts.dependencyObservations.every((d) => d.windowSeconds === 3600)).toBe(true);
  });

  it('rejects an already-aborted signal before doing any I/O', async () => {
    const { reader, calls } = createDesignPartnerOtelReader();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createOtelAdapter(reader).collect({ ...scope, signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
