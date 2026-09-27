import { describe, expect, it } from 'vitest';
import { findByoFallbackViolations } from './byo-fallback-check.js';

describe('findByoFallbackViolations (012 T070, FR-046, R-08, quickstart 23)', () => {
  it('flags a BYO tenant run that used a provider other than the one it configured', () => {
    const violations = findByoFallbackViolations(
      [{ tenantId: 't1', mode: 'customer_byo', provider: 'anthropic' }],
      [{ id: 'r1', tenantId: 't1', provider: 'openai' }],
    );
    expect(violations).toEqual([
      'agent_run r1: BYO tenant t1 configured for anthropic but the run used openai',
    ]);
  });

  it('passes a BYO tenant run that used its own configured provider', () => {
    const violations = findByoFallbackViolations(
      [{ tenantId: 't1', mode: 'customer_byo', provider: 'anthropic' }],
      [{ id: 'r1', tenantId: 't1', provider: 'anthropic' }],
    );
    expect(violations).toEqual([]);
  });

  it('never flags a Healer-provided tenant switching providers — the trap is BYO-specific', () => {
    const violations = findByoFallbackViolations(
      [{ tenantId: 't1', mode: 'healer_provided', provider: 'anthropic' }],
      [{ id: 'r1', tenantId: 't1', provider: 'openai' }],
    );
    expect(violations).toEqual([]);
  });

  it('ignores a run for a tenant with no provider config on record', () => {
    expect(
      findByoFallbackViolations([], [{ id: 'r1', tenantId: 'unknown', provider: 'openai' }]),
    ).toEqual([]);
  });
});
