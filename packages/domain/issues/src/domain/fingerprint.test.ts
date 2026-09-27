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
});
