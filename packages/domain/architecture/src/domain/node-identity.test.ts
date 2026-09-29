import { describe, expect, it } from 'vitest';
import { mintNodeId } from './node-identity.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('mintNodeId (R-12)', () => {
  it('mints a well-formed UUID v7 (version nibble 7, variant bits 10)', () => {
    expect(mintNodeId()).toMatch(UUID_V7);
  });

  it('never mints the same id twice, even at the same millisecond', () => {
    const now = Date.now();
    const ids = Array.from({ length: 50 }, () => mintNodeId(now));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts later-minted ids after earlier ones when timestamps differ', () => {
    const earlier = mintNodeId(1_000_000);
    const later = mintNodeId(2_000_000);
    expect(later > earlier).toBe(true);
  });

  it('takes no path-like input at all — identity cannot be derived from one', () => {
    // mintNodeId's only parameter is an optional timestamp with a default (hence arity 0, per
    // JS function.length semantics) — there is no argument through which a repository path, a
    // Kubernetes resource ref or a trace service name could flow in.
    expect(mintNodeId.length).toBe(0);
    expect(mintNodeId()).not.toBe(mintNodeId());
  });
});
