import { describe, expect, it } from 'vitest';
import { defaultCharacteristicVocabulary } from './characteristics.js';
import {
  detectNaturalKeyCollisions,
  type ComponentRepositories,
} from './natural-key-collisions.js';
import { placeDeploymentUnit } from './deployment-unit-placement.js';
import { validateComponentAttr } from './kind-attributes.js';
import { validateEdge } from './structural-edges.js';

describe('T051: a deployment unit with no code component is an external component (spec edge case, quickstart 38)', () => {
  const sidecar = { naturalKey: 'prod/envoy-sidecar', name: 'envoy-sidecar' };

  it('models it as an external component that deploys to the unit, endpoints carrying their kind', () => {
    expect(placeDeploymentUnit(sidecar, null)).toEqual({
      kind: 'external_component',
      component: {
        naturalKey: 'prod/envoy-sidecar',
        name: 'envoy-sidecar',
        componentType: 'external',
        characteristics: ['third_party'],
      },
      deploys: {
        from: { kind: 'component', naturalKey: 'prod/envoy-sidecar' },
        to: { kind: 'deployment_unit', naturalKey: 'prod/envoy-sidecar' },
      },
    });
  });

  it('the placement output is itself a valid component and a valid deploys edge', () => {
    const p = placeDeploymentUnit(sidecar, null);
    if (p.kind !== 'external_component') throw new Error('expected external_component');
    expect(
      validateComponentAttr(
        { componentType: p.component.componentType, characteristics: p.component.characteristics },
        defaultCharacteristicVocabulary(),
      ).ok,
    ).toBe(true);
    expect(validateEdge('deploys', p.deploys.from.kind, p.deploys.to.kind)).toEqual({ ok: true });
  });

  it('never carries a repository: no built_from, no repository field — nothing to force-fit', () => {
    const p = placeDeploymentUnit(sidecar, null);
    expect(JSON.stringify(p)).not.toMatch(/built_from|repositor/i);
  });

  it('a unit that matches a code component creates no external component', () => {
    expect(placeDeploymentUnit(sidecar, 'orders')).toEqual({
      kind: 'matched_component',
      componentNaturalKey: 'orders',
    });
  });

  it.each([
    ['empty matched key', sidecar, ''],
    ['whitespace matched key', sidecar, '  '],
    ['empty unit natural key', { naturalKey: '', name: 'x' }, null],
    ['empty unit name', { naturalKey: 'k', name: ' ' }, null],
  ])('refuses %s instead of inventing an identity', (_label, unit, matched) => {
    expect(() => placeDeploymentUnit(unit, matched)).toThrow();
  });
});

describe('T052: a shared natural_key is surfaced as a collision, never merged (R-12, quickstart 40)', () => {
  const c = (
    componentId: string,
    naturalKey: string,
    ...repositoryIds: string[]
  ): ComponentRepositories => ({
    componentId,
    naturalKey,
    repositoryIds,
  });

  it('cross-repository: two components, one key, different repositories, both candidates kept', () => {
    const result = detectNaturalKeyCollisions([
      c('a', 'billing', 'r1'),
      c('b', 'billing', 'r2'),
      c('x', 'orders', 'r1'),
    ]);
    expect(result).toEqual([
      {
        naturalKey: 'billing',
        scope: 'cross_repository',
        candidates: [
          { componentId: 'a', naturalKey: 'billing', repositoryIds: ['r1'] },
          { componentId: 'b', naturalKey: 'billing', repositoryIds: ['r2'] },
        ],
      },
    ]);
  });

  it('same-repository duplicates are reported, not dropped', () => {
    const [collision, ...rest] = detectNaturalKeyCollisions([
      c('a', 'billing', 'r1'),
      c('b', 'billing', 'r1'),
    ]);
    expect(rest).toEqual([]);
    expect(collision?.scope).toBe('same_repository');
    expect(collision?.candidates.map((x) => x.componentId)).toEqual(['a', 'b']);
  });

  it('components with no repository are reported, not dropped', () => {
    const [collision] = detectNaturalKeyCollisions([c('a', 'billing'), c('b', 'billing')]);
    expect(collision?.scope).toBe('unrepositoried');
  });

  it('one unrepositoried duplicate beside a repositoried one is still unrepositoried, not hidden', () => {
    const [collision] = detectNaturalKeyCollisions([c('a', 'billing', 'r1'), c('b', 'billing')]);
    expect(collision?.scope).toBe('unrepositoried');
  });

  it('one component built from two repositories is not a collision with itself', () => {
    expect(detectNaturalKeyCollisions([c('a', 'payments', 'r1', 'r2')])).toEqual([]);
  });

  it('one component listed twice (once per repository) is merged by id first, not a collision', () => {
    expect(
      detectNaturalKeyCollisions([c('a', 'payments', 'r1'), c('a', 'payments', 'r2')]),
    ).toEqual([]);
  });

  it('keys are grouped by trim + lower-case but the original keys stay on the candidates', () => {
    const [collision] = detectNaturalKeyCollisions([
      c('a', 'Billing', 'r1'),
      c('b', ' billing ', 'r2'),
    ]);
    expect(collision?.naturalKey).toBe('billing');
    expect(collision?.candidates.map((x) => x.naturalKey)).toEqual(['Billing', ' billing ']);
  });

  it('distinct keys never collide', () => {
    expect(detectNaturalKeyCollisions([c('a', 'x', 'r1'), c('b', 'y', 'r2')])).toEqual([]);
  });

  it('returns candidates only — the result has no merged identifier to write back', () => {
    const [collision] = detectNaturalKeyCollisions([c('a', 'k', 'r1'), c('b', 'k', 'r2')]);
    expect(Object.keys(collision ?? {}).sort()).toEqual(['candidates', 'naturalKey', 'scope']);
  });
});
