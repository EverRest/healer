import { describe, expect, it } from 'vitest';
import { edgeKey, nodeRefKey } from './node-key.js';

describe('nodeRefKey (004 reconciliation batch (f)): canonical matching, not exact', () => {
  it('"Checkout" and "checkout" resolve to the same identity', () => {
    expect(nodeRefKey({ nodeKind: 'component', naturalKey: 'Checkout' })).toBe(
      nodeRefKey({ nodeKind: 'component', naturalKey: 'checkout' }),
    );
  });

  it('surrounding whitespace does not change identity either', () => {
    expect(nodeRefKey({ nodeKind: 'component', naturalKey: '  Checkout  ' })).toBe(
      nodeRefKey({ nodeKind: 'component', naturalKey: 'checkout' }),
    );
  });

  it('still distinguishes different kinds sharing a natural key', () => {
    expect(nodeRefKey({ nodeKind: 'component', naturalKey: 'checkout' })).not.toBe(
      nodeRefKey({ nodeKind: 'repository', naturalKey: 'checkout' }),
    );
  });

  it('edgeKey inherits the same canonical matching through nodeRefKey', () => {
    const a = { nodeKind: 'component', naturalKey: 'Checkout' } as const;
    const b = { nodeKind: 'component', naturalKey: 'checkout' } as const;
    const to = { nodeKind: 'repository', naturalKey: 'repo' } as const;
    expect(edgeKey(a, to, 'depends_on', 'code')).toBe(edgeKey(b, to, 'depends_on', 'code'));
  });
});
