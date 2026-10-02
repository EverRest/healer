import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import { getSystemContext } from './get-system-context.js';
import type { SystemContext, SystemContextRepository } from '../../domain/system-context.js';
import { toReadEnvelope } from '../../domain/read-envelope.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000c1');

const EMPTY: SystemContext = {
  components: [],
  deploymentUnits: [],
  repositories: [],
  characteristics: [],
  edges: [],
  excludedEdges: 0,
};

describe('getSystemContext (004 T049, FR-020, quickstart 16)', () => {
  it('reads with the tenant of the auth context and nothing else', async () => {
    const seen: unknown[] = [];
    const repo: SystemContextRepository = {
      read: async (where) => {
        seen.push(where);
        return toReadEnvelope(
          3,
          true,
          { nodesConfirmed: 0, nodesTotal: 0, edgesConfirmed: 0, edgesTotal: 0 },
          EMPTY,
        );
      },
    };
    const result = await getSystemContext(repo, CONTEXT);
    expect(seen).toEqual([{ tenantId: CONTEXT.tenantId }]);
    expect(result.graphVersion).toBe(3);
  });

  it('has no architecture-style field in the result type, at any depth', () => {
    const context: SystemContext = EMPTY;
    // @ts-expect-error -- no `style` on the context
    void context.style;
    // @ts-expect-error -- no `architecture` on the context
    void context.architecture;
    // @ts-expect-error -- no `systemKind` on the context
    void context.systemKind;
    // @ts-expect-error -- no `deploymentStyle` on the context
    void context.deploymentStyle;
    const node = {} as SystemContext['components'][number];
    // @ts-expect-error -- no `style` on a node
    void node.style;
    // @ts-expect-error -- no `architecture` on a node
    void node.architecture;
    const edge = {} as SystemContext['edges'][number];
    // @ts-expect-error -- no `style` on an edge
    void edge.style;
    // The result is a closed shape: an extra field is a compile error, not a quiet widening.
    const widened: SystemContext = {
      ...EMPTY,
      // @ts-expect-error -- excess property: nothing can carry a discriminator in
      style: 'x',
    };
    expect(widened).toBeDefined();
  });

  it('cannot hold a rejected element: the state type excludes it', () => {
    const node = {} as SystemContext['components'][number];
    const edge = {} as SystemContext['edges'][number];
    // @ts-expect-error -- 'rejected' is not a state a context node can be in
    const n: typeof node.state = 'rejected';
    // @ts-expect-error -- nor an edge
    const e: typeof edge.state = 'rejected';
    const ok: typeof node.state = 'confirmed';
    expect([n, e, ok]).toHaveLength(3);
  });
});
