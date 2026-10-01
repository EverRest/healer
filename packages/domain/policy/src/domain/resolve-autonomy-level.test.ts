import { describe, expect, it } from 'vitest';
import type { AutonomyGrant } from './autonomy-grant-repository.js';
import { resolveAutonomyLevel } from './resolve-autonomy-level.js';

const TARGET = {
  actionKey: 'change.open_pull_request',
  componentId: 'component-a',
  environment: 'production',
  issueKind: 'production_incident',
};

function grant(overrides: Partial<AutonomyGrant> = {}): AutonomyGrant {
  return {
    id: 'grant-1',
    actionKey: TARGET.actionKey,
    level: 1,
    grantedBy: 'pavlo',
    grantedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('resolveAutonomyLevel (T039)', () => {
  it('no grants → level 0', () => {
    expect(resolveAutonomyLevel([], TARGET)).toBe(0);
  });

  it('a wildcard (all-scope) grant matches any component/environment/issue kind', () => {
    expect(resolveAutonomyLevel([grant({ level: 2 })], TARGET)).toBe(2);
  });

  it('a grant scoped to a different component does not match (quickstart 11)', () => {
    expect(resolveAutonomyLevel([grant({ level: 2, componentId: 'component-b' })], TARGET)).toBe(0);
  });

  it('a grant scoped to a different action key does not match', () => {
    expect(
      resolveAutonomyLevel([grant({ level: 2, actionKey: 'deployment.rollback' })], TARGET),
    ).toBe(0);
  });

  it('a grant scoped to a different environment or issue kind does not match', () => {
    expect(resolveAutonomyLevel([grant({ level: 2, environment: 'staging' })], TARGET)).toBe(0);
    expect(resolveAutonomyLevel([grant({ level: 2, issueKind: 'flaky_test' })], TARGET)).toBe(0);
  });

  it('a revoked grant never contributes, even if it would otherwise match', () => {
    expect(
      resolveAutonomyLevel(
        [grant({ level: 2, revokedAt: new Date('2026-01-02T00:00:00Z'), revokedBy: 'pavlo' })],
        TARGET,
      ),
    ).toBe(0);
  });

  it('additive: the resolved level is the max over every matching grant, not their sum (data-model.md)', () => {
    expect(
      resolveAutonomyLevel(
        [grant({ id: 'g1', level: 1 }), grant({ id: 'g2', level: 2, componentId: 'component-a' })],
        TARGET,
      ),
    ).toBe(2);
  });

  it('a narrower grant never widens a broader one (data-model.md)', () => {
    const broad = grant({ id: 'g1', level: 2 });
    const narrow = grant({ id: 'g2', level: 1, componentId: 'component-a' });
    expect(resolveAutonomyLevel([broad, narrow], TARGET)).toBe(2);
  });
});
