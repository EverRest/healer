import { describe, expect, it } from 'vitest';
import type { ProposedPayload } from './proposed-payload.js';
import { proposalDigest } from './proposal-digest.js';

/**
 * T023: the digest covers op, endpoint identities, edge type, layer and normalised attributes —
 * and excludes confidence, strength, provenance, observation counts, timestamps and run id. Those
 * five are excluded by *type*: `ProposedPayload` has no field for any of them (they live on
 * `draft_item`'s own columns), so there is nothing for this function to remember to drop — the
 * tests below instead prove the three *volatile attribute* exclusions the plan calls out by name
 * (`currentVersion`, `lastDeployedAt`, `headSha`), which do appear inside `attributes` and must be
 * stripped explicitly (R-08).
 */
describe('proposalDigest (T023, R-08)', () => {
  const addComponent = (characteristics: readonly string[] = ['user_facing']): ProposedPayload => ({
    op: 'add_node',
    nodeKind: 'component',
    naturalKey: 'svc-a',
    name: 'svc-a',
    attributes: { componentType: 'service', characteristics, ownerRef: null },
  });

  const deploymentUnit = (
    currentVersion: string,
    lastDeployedAt: string | null,
  ): ProposedPayload => ({
    op: 'add_node',
    nodeKind: 'deployment_unit',
    naturalKey: 'k8s:prod/deployment/api',
    name: 'k8s:prod/deployment/api',
    attributes: {
      environment: 'prod',
      runtimeKind: 'container',
      runtimeRef: 'deployment/api',
      currentVersion,
      lastDeployedAt,
    },
  });

  it('is deterministic for the same structural content', () => {
    expect(proposalDigest(addComponent())).toBe(proposalDigest(addComponent()));
  });

  it('changes when the op changes', () => {
    const asModify: ProposedPayload = {
      op: 'modify_attributes',
      nodeKind: 'component',
      naturalKey: 'svc-a',
      name: 'svc-a',
      attributes: { componentType: 'service', characteristics: ['user_facing'], ownerRef: null },
    };
    expect(proposalDigest(addComponent())).not.toBe(proposalDigest(asModify));
  });

  it('changes when an edge type changes (quickstart 9: a changed proposal reappears)', () => {
    const base: ProposedPayload = {
      op: 'add_edge',
      from: { nodeKind: 'component', naturalKey: 'a' },
      to: { nodeKind: 'component', naturalKey: 'b' },
      edgeType: 'depends_on',
      layer: 'code',
    };
    const changedType: ProposedPayload = { ...base, edgeType: 'calls' };
    expect(proposalDigest(base)).not.toBe(proposalDigest(changedType));
  });

  it('changes when layer changes, holding everything else equal', () => {
    const base: ProposedPayload = {
      op: 'add_edge',
      from: { nodeKind: 'component', naturalKey: 'a' },
      to: { nodeKind: 'deployment_unit', naturalKey: 'b' },
      edgeType: 'deploys',
      layer: 'runtime',
    };
    const changedLayer: ProposedPayload = { ...base, layer: 'code' };
    expect(proposalDigest(base)).not.toBe(proposalDigest(changedLayer));
  });

  it('changes when a normalised attribute changes', () => {
    expect(proposalDigest(addComponent(['user_facing']))).not.toBe(
      proposalDigest(addComponent(['money_path'])),
    );
  });

  it('ignores currentVersion — deploy version moves every deploy (R-08)', () => {
    const base = deploymentUnit('v1.0.0', null);
    const redeployed = deploymentUnit('v1.0.1', null);
    expect(proposalDigest(base)).toBe(proposalDigest(redeployed));
  });

  it('ignores lastDeployedAt — recency moves on its own schedule (R-08)', () => {
    const base = deploymentUnit('v1.0.0', null);
    const laterDeploy = deploymentUnit('v1.0.0', '2026-10-01T00:00:00.000Z');
    expect(proposalDigest(base)).toBe(proposalDigest(laterDeploy));
  });

  it('is insensitive to key order (canonical JSON, sorted keys)', () => {
    const a: ProposedPayload = addComponent();
    const b = {
      attributes: { ownerRef: null, characteristics: ['user_facing'], componentType: 'service' },
      name: 'svc-a',
      naturalKey: 'svc-a',
      nodeKind: 'component',
      op: 'add_node',
    } as ProposedPayload;
    expect(proposalDigest(a)).toBe(proposalDigest(b));
  });
});
