import { describe, expect, it } from 'vitest';
import type { DiscoveryAdapter, DiscoveryFacts } from '../domain/discovery-adapter.js';
import { collectDiscovery, type DiscoverySourceRequest } from './collect-discovery.js';

const emptyFacts: DiscoveryFacts = {
  componentCandidates: [],
  deploymentUnitCandidates: [],
  dependencyObservations: [],
  repositoryRefs: [],
  collectionGaps: [],
};

function adapter(key: string, collect: DiscoveryAdapter['collect']): DiscoveryAdapter {
  return Object.freeze({
    key,
    version: '1.0.0',
    layer: 'code',
    provenance: 'derived_from_code',
    collect,
  });
}

/**
 * Review fix: an item `validateEgress` rejects used to vanish from `items` with nothing counting
 * it — the source then read as `collected`/`empty_result` even though something was actually
 * wrong with what the adapter sent (graph-contract.md §3: egress validation is one of two
 * independent checks, not advisory).
 */
describe('collectDiscovery: egress-rejected items are counted, not silently dropped (review fix)', () => {
  it('a source whose only item fails validateEgress is partial/schema_rejected, not collected/empty_result', async () => {
    const sources: DiscoverySourceRequest[] = [
      {
        requested: true,
        adapter: adapter('bad-adapter', async () => ({
          ...emptyFacts,
          // An unknown key — boundary-contract's `.strict()` schemas reject it (graph-contract.md
          // §3: "no free-form string field; anything not listed does not cross"). Cast through
          // `unknown` because this is deliberately not a value our own types would construct —
          // it stands in for a buggy or malicious third-party adapter.
          componentCandidates: [
            {
              kind: 'component_candidate',
              naturalKey: 'x',
              name: 'x',
              componentType: 'service',
              characteristics: [],
              sourcePaths: [],
              adapterKey: 'bad-adapter',
              adapterVersion: '1.0.0',
              unexpectedField: 'should never cross the boundary',
            },
          ] as unknown as DiscoveryFacts['componentCandidates'],
        })),
      },
    ];

    const [result] = await collectDiscovery(sources, {
      tenantId: 't1',
      runnerId: 'runner-1',
      perSourceTimeoutMs: 5000,
      itemCap: 1000,
    });

    expect(result!.items).toHaveLength(0);
    expect(result!.status).toBe('partial');
    expect(result!.reasonCode).toBe('schema_rejected');
    // Named by source key, never by item content (security-and-tenancy.md: no customer content
    // crosses into a gap).
    expect(result!.gaps.some((g) => g.what === 'bad-adapter' && g.why.includes('1'))).toBe(true);
  });

  it('a source with some valid and some rejected items keeps the valid ones and still reports schema_rejected', async () => {
    const sources: DiscoverySourceRequest[] = [
      {
        requested: true,
        adapter: adapter('mixed-adapter', async () => ({
          ...emptyFacts,
          componentCandidates: [
            {
              kind: 'component_candidate',
              naturalKey: 'good',
              name: 'good',
              componentType: 'service',
              characteristics: [],
              sourcePaths: [],
              adapterKey: 'mixed-adapter',
              adapterVersion: '1.0.0',
            },
            {
              kind: 'component_candidate',
              naturalKey: 'bad',
              componentType: 'service',
              characteristics: [],
              sourcePaths: [],
              adapterKey: 'mixed-adapter',
              adapterVersion: '1.0.0',
            } as unknown as DiscoveryFacts['componentCandidates'][number], // missing required `name`
          ],
        })),
      },
    ];

    const [result] = await collectDiscovery(sources, {
      tenantId: 't1',
      runnerId: 'runner-1',
      perSourceTimeoutMs: 5000,
      itemCap: 1000,
    });

    expect(result!.items).toHaveLength(1);
    expect(result!.status).toBe('partial');
    expect(result!.reasonCode).toBe('schema_rejected');
  });
});
