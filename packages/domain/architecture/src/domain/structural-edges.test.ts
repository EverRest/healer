import { describe, expect, it } from 'vitest';
import { EDGE_TYPES, NODE_KINDS } from './graph-vocabulary.js';
import {
  findEdgeViolations,
  STRUCTURAL_EDGE_TYPES,
  validateEdge,
  type GraphShapeEdge,
  type GraphShapeNode,
} from './structural-edges.js';

const comp = (id: string): GraphShapeNode => ({ id, kind: 'component' });
const unit = (id: string): GraphShapeNode => ({ id, kind: 'deployment_unit' });
const repo = (id: string): GraphShapeNode => ({ id, kind: 'repository' });
const edge = (type: GraphShapeEdge['type'], from: string, to: string): GraphShapeEdge => ({
  type,
  from,
  to,
});

describe('T042: a single-deployable system (n components, one unit) needs no special case (FR-002, quickstart 13)', () => {
  it.each([1, 3, 50])('%i components joined by contains, all deployed to ONE unit', (n) => {
    const components = Array.from({ length: n }, (_, i) => comp(`c${i}`));
    const nodes = [...components, unit('u')];
    const edges = [
      ...components.slice(1).map((c) => edge('contains', 'c0', c.id)),
      ...components.map((c) => edge('deploys', c.id, 'u')),
    ];

    expect(findEdgeViolations(nodes, edges)).toEqual([]);
  });
});

describe('T043: component <-> repository is many-to-many through built_from (FR-003, quickstart 14)', () => {
  it('three components built from one repository', () => {
    const nodes = [comp('a'), comp('b'), comp('c'), repo('r')];
    const edges = ['a', 'b', 'c'].map((c) => edge('built_from', c, 'r'));
    expect(findEdgeViolations(nodes, edges)).toEqual([]);
  });

  it('one component built from two repositories', () => {
    const nodes = [comp('a'), repo('r1'), repo('r2')];
    const edges = [edge('built_from', 'a', 'r1'), edge('built_from', 'a', 'r2')];
    expect(findEdgeViolations(nodes, edges)).toEqual([]);
  });
});

describe('T046: structural separations are edges with fixed endpoint kinds (FR-002, FR-003)', () => {
  it('the five structural edge types are exactly deploys, built_from, contains, implements, exposes', () => {
    expect([...STRUCTURAL_EDGE_TYPES].sort()).toEqual(
      ['built_from', 'contains', 'deploys', 'exposes', 'implements'].sort(),
    );
  });

  it.each([
    ['deploys', 'component', 'deployment_unit'],
    ['built_from', 'component', 'repository'],
    ['contains', 'component', 'component'],
    ['implements', 'endpoint', 'component'],
    ['exposes', 'deployment_unit', 'endpoint'],
    ['exposes', 'component', 'endpoint'],
  ] as const)('%s: %s -> %s is accepted', (type, from, to) => {
    expect(validateEdge(type, from, to)).toEqual({ ok: true });
  });

  it('every structural type rejects every endpoint pair outside its rule', () => {
    const allowed = new Set([
      'deploys:component:deployment_unit',
      'built_from:component:repository',
      'contains:component:component',
      'implements:endpoint:component',
      'exposes:deployment_unit:endpoint',
      'exposes:component:endpoint',
    ]);
    for (const type of STRUCTURAL_EDGE_TYPES)
      for (const from of NODE_KINDS)
        for (const to of NODE_KINDS) {
          const result = validateEdge(type, from, to);
          expect(result.ok, `${type}:${from}:${to}`).toBe(allowed.has(`${type}:${from}:${to}`));
        }
  });

  it('a deployment unit is never built_from a repository (that is the force-fit FR-003 forbids)', () => {
    expect(validateEdge('built_from', 'deployment_unit', 'repository').ok).toBe(false);
    expect(validateEdge('deploys', 'component', 'repository').ok).toBe(false);
  });

  it('the three explicitly unconstrained edge types accept any pair (their rules belong to other tasks)', () => {
    for (const type of ['calls', 'depends_on', 'serves_feature'] as const)
      expect(validateEdge(type, 'component', 'component')).toEqual({ ok: true });
  });

  it('every known edge type is either structural or one of those three — the table is exhaustive', () => {
    const unconstrained = ['calls', 'depends_on', 'serves_feature'];
    expect([...EDGE_TYPES].sort()).toEqual([...STRUCTURAL_EDGE_TYPES, ...unconstrained].sort());
  });

  it.each(['bogus', 'constructor', 'toString', '__proto__', ''])(
    'an unknown edge type %j is refused, never accepted (fails closed)',
    (type) => {
      expect(validateEdge(type as never, 'component', 'component')).toEqual({
        ok: false,
        reason: 'unknown edge type',
      });
    },
  );

  it('findEdgeViolations names the offending edge and an edge to an unknown node', () => {
    const nodes = [comp('a'), repo('r')];
    const bad = edge('deploys', 'a', 'r');
    const dangling = edge('contains', 'a', 'ghost');
    const violations = findEdgeViolations(nodes, [bad, dangling]);
    expect(violations.map((v) => v.edge)).toEqual([bad, dangling]);
    expect(violations[1]?.reason).toMatch(/unknown/);
  });
});
