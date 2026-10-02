import { describe, expect, it } from 'vitest';
import type { DeploymentUnitCandidate } from '@healer/boundary-contract';
import { normaliseDeploymentUnitAttributes, sameAttributes } from './attribute-normalisation.js';

/**
 * Review fix: the confirmed side's `lastDeployedAt` is rebuilt from a `Date` column via
 * `.toISOString()` (`prisma-discovery-repository.ts`), while the candidate side used to keep the
 * wire's raw string verbatim — two representations of the identical instant that compare unequal
 * as strings, producing a spurious `modify_attributes` on every re-run even when nothing real
 * changed.
 */
describe('normaliseDeploymentUnitAttributes: lastDeployedAt format (review fix)', () => {
  const base: DeploymentUnitCandidate = {
    kind: 'deployment_unit_candidate',
    naturalKey: 'k8s:prod/deployment/api',
    environment: 'prod',
    runtimeKind: 'container',
    runtimeRef: 'deployment/api',
    currentVersion: 'v1',
  };

  it('normalises to the same value whether the wire string has 3-digit millis or none', () => {
    const withMillis = normaliseDeploymentUnitAttributes({
      ...base,
      lastDeployedAt: '2026-10-01T00:00:00.000Z',
    });
    const withoutMillis = normaliseDeploymentUnitAttributes({
      ...base,
      lastDeployedAt: '2026-10-01T00:00:00Z',
    });
    expect(sameAttributes(withMillis, withoutMillis)).toBe(true);
  });

  it('matches a Date column rebuilt via .toISOString() for the identical instant', () => {
    const fromWire = normaliseDeploymentUnitAttributes({
      ...base,
      lastDeployedAt: '2026-10-01T00:00:00Z',
    });
    const fromDateColumn = new Date('2026-10-01T00:00:00Z').toISOString();
    expect(fromWire?.lastDeployedAt).toBe(fromDateColumn);
  });

  it('stays null when the wire omits it', () => {
    expect(normaliseDeploymentUnitAttributes(base)?.lastDeployedAt).toBeNull();
  });
});
