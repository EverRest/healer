import { describe, expect, it } from 'vitest';
import { computeFingerprint, DEFAULT_NORMALISATION_RULES } from './fingerprint.js';

/**
 * Fingerprint stability across volatile parts (001 T016, R-01, FR-003, quickstart 2, 3): the same
 * failure with different identifiers, memory addresses and generated-file line offsets must hash
 * to the same fingerprint; a genuinely different exception type must not.
 */
describe('computeFingerprint (001 T016, R-01, FR-003)', () => {
  it('is identical for the same failure with different request ids, addresses and line offsets', () => {
    const a = computeFingerprint(
      {
        component: 'checkout-service',
        environment: 'prod',
        exceptionType: 'NullPointerException',
        frames: [
          'at Checkout.charge(Checkout.java:42:7)',
          'req=3fa1c2d0-1111-4a11-8a11-000000000001 at 0xdeadbeef',
        ],
        errorCode: 'E500',
      },
      DEFAULT_NORMALISATION_RULES,
    );
    const b = computeFingerprint(
      {
        component: 'checkout-service',
        environment: 'prod',
        exceptionType: 'NullPointerException',
        frames: [
          'at Checkout.charge(Checkout.java:99:3)',
          'req=9bf2e4a1-2222-4b22-9b22-000000000002 at 0xcafebabe',
        ],
        errorCode: 'E500',
      },
      DEFAULT_NORMALISATION_RULES,
    );
    expect(a).toBe(b);
  });

  it('differs for a genuinely different exception type on the same component', () => {
    const a = computeFingerprint(
      { component: 'checkout-service', environment: 'prod', exceptionType: 'NullPointerException' },
      DEFAULT_NORMALISATION_RULES,
    );
    const b = computeFingerprint(
      { component: 'checkout-service', environment: 'prod', exceptionType: 'TimeoutException' },
      DEFAULT_NORMALISATION_RULES,
    );
    expect(a).not.toBe(b);
  });

  it('differs across environments and components — a hash over both, not just the signature', () => {
    const base = { exceptionType: 'NullPointerException' };
    const prod = computeFingerprint(
      { ...base, component: 'checkout-service', environment: 'prod' },
      DEFAULT_NORMALISATION_RULES,
    );
    const staging = computeFingerprint(
      { ...base, component: 'checkout-service', environment: 'staging' },
      DEFAULT_NORMALISATION_RULES,
    );
    const otherComponent = computeFingerprint(
      { ...base, component: 'billing-service', environment: 'prod' },
      DEFAULT_NORMALISATION_RULES,
    );
    expect(prod).not.toBe(staging);
    expect(prod).not.toBe(otherComponent);
  });

  it('is stable for the identical input across repeated calls — deterministic, not time-based', () => {
    const input = { component: 'checkout-service', environment: 'prod', errorCode: 'E500' };
    expect(computeFingerprint(input, DEFAULT_NORMALISATION_RULES)).toBe(
      computeFingerprint(input, DEFAULT_NORMALISATION_RULES),
    );
  });

  it('an ISO timestamp embedded in a frame does not split the fingerprint', () => {
    const a = computeFingerprint(
      { component: 'c', environment: 'prod', frames: ['failed at 2026-01-01T00:00:00.123Z'] },
      DEFAULT_NORMALISATION_RULES,
    );
    const b = computeFingerprint(
      { component: 'c', environment: 'prod', frames: ['failed at 2026-06-15T08:30:59Z'] },
      DEFAULT_NORMALISATION_RULES,
    );
    expect(a).toBe(b);
  });

  it('a variable numeric URL segment in the endpoint template does not split the fingerprint', () => {
    const a = computeFingerprint(
      { component: 'c', environment: 'prod', endpointTemplate: '/orders/48291/items' },
      DEFAULT_NORMALISATION_RULES,
    );
    const b = computeFingerprint(
      { component: 'c', environment: 'prod', endpointTemplate: '/orders/1029384/items' },
      DEFAULT_NORMALISATION_RULES,
    );
    expect(a).toBe(b);
  });

  it('does not confuse a frame containing a NUL byte with a frame boundary — real review finding', () => {
    // Joining fields/frames with a raw NUL separator meant one frame that happens to contain a
    // NUL byte was indistinguishable from two separate frames split at that byte.
    const oneFrameWithNul = computeFingerprint(
      { component: 'c', environment: 'e', frames: ['x\u0000y'] },
      { stripPatterns: [] },
    );
    const twoFrames = computeFingerprint(
      { component: 'c', environment: 'e', frames: ['x', 'y'] },
      { stripPatterns: [] },
    );
    expect(oneFrameWithNul).not.toBe(twoFrames);
  });

  it('normalises a Java-style trailing line:column even though the default rules were written case-lowered — case-insensitive pattern match', () => {
    // The rule's own pattern is lowercase, but a *future* ruleset version's pattern could contain
    // uppercase, and the input is lowercased before matching — the match must still happen.
    const rules = { stripPatterns: ['LINE:\\d+'] };
    const a = computeFingerprint(
      { component: 'c', environment: 'e', frames: ['at Line:42'] },
      rules,
    );
    const b = computeFingerprint(
      { component: 'c', environment: 'e', frames: ['at Line:99'] },
      rules,
    );
    expect(a).toBe(b);
  });

  it('normalises a generated-file line:column shift beyond the default patterns’ narrow suffix match — top frames still collapse', () => {
    const a = computeFingerprint(
      { component: 'c', environment: 'e', frames: ['at X(Checkout.java:42)'] },
      DEFAULT_NORMALISATION_RULES,
    );
    const b = computeFingerprint(
      { component: 'c', environment: 'e', frames: ['at X(Checkout.java:57)'] },
      DEFAULT_NORMALISATION_RULES,
    );
    expect(a).toBe(b);
  });

  it('only the top frames affect the fingerprint — a difference below the limit does not split it', () => {
    const deepFrames = (bottom: string) => [
      'at Checkout.charge(Checkout.java:1:1)',
      'at Checkout.process(Checkout.java:2:1)',
      'at Checkout.validate(Checkout.java:3:1)',
      'at Checkout.route(Checkout.java:4:1)',
      'at Checkout.dispatch(Checkout.java:5:1)',
      bottom,
    ];
    const a = computeFingerprint(
      {
        component: 'c',
        environment: 'e',
        frames: deepFrames('at Framework.invoke(Framework.java:100:1)'),
      },
      DEFAULT_NORMALISATION_RULES,
    );
    const b = computeFingerprint(
      {
        component: 'c',
        environment: 'e',
        frames: deepFrames('at Framework.dispatch(Framework.java:200:1)'),
      },
      DEFAULT_NORMALISATION_RULES,
    );
    expect(a).toBe(b);
  });
});
