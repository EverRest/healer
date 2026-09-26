import { describe, expect, it } from 'vitest';
import { currentCorrelationId, newCorrelationId, withCorrelation } from './index.js';

describe('correlation', () => {
  it('propagates through awaited work', async () => {
    const id = newCorrelationId();
    const seen = await withCorrelation(id, async () => {
      await Promise.resolve();
      return currentCorrelationId();
    });
    expect(seen).toBe(id);
  });

  it('is undefined outside a correlated scope rather than invented', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('does not leak between sibling scopes', async () => {
    const [a, b] = await Promise.all([
      withCorrelation('a', async () => currentCorrelationId()),
      withCorrelation('b', async () => currentCorrelationId()),
    ]);
    expect([a, b]).toEqual(['a', 'b']);
  });
});
