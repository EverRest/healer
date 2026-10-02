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

  it('models it as an external component that deploys to the unit', () => {
    const p = placeDeploymentUnit(sidecar, null);
    expect(p).toEqual({
      kind: 'external_component',
      component: {
        naturalKey: 'prod/envoy-sidecar',
        name: 'envoy-sidecar',
        componentType: 'external',
        characteristics: ['third_party'],
      },
      deploys: { fromNaturalKey: 'prod/envoy-sidecar', toNaturalKey: 'prod/envoy-sidecar' },
    });
  });

  it('the placement is itself a valid component and a valid deploys edge', () => {
    const p = placeDeploymentUnit(sidecar, null);
    if (p.kind !== 'external_component') throw new Error('expected external_component');
    expect(
      validateComponentAttr(
        { componentType: p.component.componentType, characteristics: p.component.characteristics },
        defaultCharacteristicVocabulary(),
      ).ok,
    ).toBe(true);
    expect(validateEdge('deploys', 'component', 'deployment_unit')).toEqual({ ok: true });
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
});

describe('T052: a natural_key shared across repositories is a collision, never a merge (R-12, quickstart 40)', () => {
  const c = (
    componentId: string,
    naturalKey: string,
    ...repositoryIds: string[]
  ): ComponentRepositories => ({
    componentId,
    naturalKey,
    repositoryIds,
  });

  it('surfaces two components with one natural_key in different repositories, both candidates kept', () => {
    const result = detectNaturalKeyCollisions([
      c('a', 'billing', 'r1'),
      c('b', 'billing', 'r2'),
      c('x', 'orders', 'r1'),
    ]);
    expect(result).toEqual([
      {
        naturalKey: 'billing',
        candidates: [
          { componentId: 'a', repositoryIds: ['r1'] },
          { componentId: 'b', repositoryIds: ['r2'] },
        ],
      },
    ]);
  });

  it('the same key in the same repository is not a cross-repository collision', () => {
    expect(detectNaturalKeyCollisions([c('a', 'billing', 'r1'), c('b', 'billing', 'r1')])).toEqual(
      [],
    );
  });

  it('one component built from two repositories is not a collision with itself', () => {
    expect(detectNaturalKeyCollisions([c('a', 'payments', 'r1', 'r2')])).toEqual([]);
  });

  it('distinct keys never collide', () => {
    expect(detectNaturalKeyCollisions([c('a', 'x', 'r1'), c('b', 'y', 'r2')])).toEqual([]);
  });

  it('returns candidates only — the result has no merged identifier to write back', () => {
    const [collision] = detectNaturalKeyCollisions([c('a', 'k', 'r1'), c('b', 'k', 'r2')]);
    expect(Object.keys(collision ?? {}).sort()).toEqual(['candidates', 'naturalKey']);
  });
});
