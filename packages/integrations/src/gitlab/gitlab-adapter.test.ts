import { describe, expect, it } from 'vitest';
import { createGitlabAdapter } from './gitlab-adapter.js';
import { createDesignPartnerGitlabReader } from '../test-support/design-partner.js';

const scope = { tenantId: 'tenant-1', runnerId: 'runner-1' };

describe('createGitlabAdapter (A2, FR-020, contracts/graph-contract.md §3)', () => {
  it('fixes key/version/layer/provenance with no field to override', () => {
    const adapter = createGitlabAdapter(createDesignPartnerGitlabReader().reader);
    expect(adapter.key).toBe('gitlab');
    expect(adapter.version).toBe('0.2.0');
    expect(adapter.layer).toBe('code');
    expect(adapter.provenance).toBe('derived_from_code');
  });

  it('collects one component per workspace package manifest, skipping the root manifest', async () => {
    const { reader } = createDesignPartnerGitlabReader();
    const facts = await createGitlabAdapter(reader).collect(scope);

    expect(facts.componentCandidates.map((c) => c.naturalKey).sort()).toEqual([
      'backend',
      'frontend',
      'shared',
      'worker',
    ]);
    expect(
      facts.componentCandidates.every(
        (c) => c.adapterKey === 'gitlab' && c.adapterVersion === '0.2.0',
      ),
    ).toBe(true);
    expect(facts.collectionGaps).toEqual([]);
  });

  it('classifies each workspace package by the adapter-local heuristic', async () => {
    const { reader } = createDesignPartnerGitlabReader();
    const facts = await createGitlabAdapter(reader).collect(scope);
    const byKey = new Map(facts.componentCandidates.map((c) => [c.naturalKey, c]));
    expect(byKey.get('backend')?.componentType).toBe('service');
    expect(byKey.get('frontend')?.componentType).toBe('frontend');
    expect(byKey.get('worker')?.componentType).toBe('worker');
    expect(byKey.get('shared')?.componentType).toBe('library');
  });

  it('emits a depends_on observation for each workspace-internal dependency, layer/provenance fixed to its own constants', async () => {
    const { reader } = createDesignPartnerGitlabReader();
    const facts = await createGitlabAdapter(reader).collect(scope);
    const pairs = facts.dependencyObservations
      .map((d) => `${d.fromNaturalKey}->${d.toNaturalKey}`)
      .sort();
    expect(pairs).toEqual(['frontend->shared', 'worker->backend', 'worker->shared']);
    expect(
      facts.dependencyObservations.every(
        (d) =>
          d.layer === 'code' && d.provenance === 'derived_from_code' && d.edgeType === 'depends_on',
      ),
    ).toBe(true);
  });

  it('emits one repository_ref naming every discovered component', async () => {
    const { reader } = createDesignPartnerGitlabReader();
    const facts = await createGitlabAdapter(reader).collect(scope);
    expect(facts.repositoryRefs).toHaveLength(1);
    const repo = facts.repositoryRefs[0];
    if (!repo) throw new Error('expected one repository_ref');
    expect(repo.projectRef).toBe('design-partner/monorepo');
    expect(repo.defaultBranch).toBe('main');
    expect(new Set(repo.componentNaturalKeys)).toEqual(
      new Set(['backend', 'frontend', 'worker', 'shared']),
    );
  });

  it('T032: an unparsable manifest yields a collection_gap naming its path; every other component is still returned', async () => {
    const { reader } = createDesignPartnerGitlabReader({
      fileOverrides: { 'apps/backend/package.json': '{ this is not json' },
    });
    const facts = await createGitlabAdapter(reader).collect(scope);
    expect(facts.collectionGaps).toEqual([
      {
        kind: 'collection_gap',
        what: 'apps/backend/package.json',
        why: 'unparsable manifest',
        withheldByRedaction: false,
      },
    ]);
    expect(facts.componentCandidates.map((c) => c.naturalKey).sort()).toEqual([
      'frontend',
      'shared',
      'worker',
    ]);
  });

  it('rejects an already-aborted signal before doing any I/O', async () => {
    const { reader, calls } = createDesignPartnerGitlabReader();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createGitlabAdapter(reader).collect({ ...scope, signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
