import { describe, expect, it } from 'vitest';
import { CORRELATION_WINDOW_MS, correlates } from './correlation.js';
import type { Issue } from './issue.js';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    tenantId: 'tenant-1',
    kind: 'monitoring_alert',
    componentId: 'component-1',
    environment: 'prod',
    severity: 'high',
    state: 'detected',
    fingerprint: 'fp1',
    rulesetVersion: 1,
    occurrenceCount: 1n,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    staleAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('correlates (001 T039, FR-020, quickstart 26)', () => {
  it('matches two issues sharing componentId and environment, first seen inside the window', () => {
    const a = issue({ id: 'a' });
    const b = issue({
      id: 'b',
      kind: 'user_report',
      firstSeenAt: new Date(a.firstSeenAt.getTime() + CORRELATION_WINDOW_MS / 2),
    });
    expect(correlates(a, b)).toBe(true);
  });

  it('does not match different components', () => {
    const a = issue({ id: 'a', componentId: 'component-1' });
    const b = issue({ id: 'b', componentId: 'component-2' });
    expect(correlates(a, b)).toBe(false);
  });

  it('does not match different environments', () => {
    const a = issue({ id: 'a', environment: 'prod' });
    const b = issue({ id: 'b', environment: 'staging' });
    expect(correlates(a, b)).toBe(false);
  });

  it('does not match outside the window', () => {
    const a = issue({ id: 'a' });
    const b = issue({
      id: 'b',
      firstSeenAt: new Date(a.firstSeenAt.getTime() + CORRELATION_WINDOW_MS + 1),
    });
    expect(correlates(a, b)).toBe(false);
  });

  it('never matches when either componentId is null — the guard that keeps this dormant until 004 lands', () => {
    const a = issue({ id: 'a', componentId: null });
    const b = issue({ id: 'b', componentId: null });
    expect(correlates(a, b)).toBe(false);
  });

  it('is symmetric — order of arguments does not matter', () => {
    const a = issue({ id: 'a' });
    const b = issue({ id: 'b', firstSeenAt: new Date(a.firstSeenAt.getTime() + 1000) });
    expect(correlates(a, b)).toBe(correlates(b, a));
  });
});
