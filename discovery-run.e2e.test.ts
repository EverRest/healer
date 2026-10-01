import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { TenantContext, withCorrelation } from '@healer/shared';
import {
  type ComponentCandidate,
  type DependencyObservation,
  type DeploymentUnitCandidate,
  type DiscoveryAdapter,
  type DiscoveryFacts,
  type DiscoveryScope,
  type DiscoverySourceRequest,
  type RepositoryRef,
  PrismaDiscoveryRepository,
  collectDiscovery,
  ingestDiscoveryBatch,
  proposalDigest,
  runDiscovery,
  startDiscoveryRun,
} from '@healer/domain-architecture';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 004 Phase 3 US1 (T018-T021, T023, T032, T035 write path): discovery is the front door and
 * produces a draft without ever writing the active graph. One shared Postgres container across
 * every scenario below (each uses its own tenant id), migrations applied once in `beforeAll`.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));
function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const emptyFacts: DiscoveryFacts = {
  componentCandidates: [],
  deploymentUnitCandidates: [],
  dependencyObservations: [],
  repositoryRefs: [],
  collectionGaps: [],
};

function fakeAdapter(
  key: string,
  layer: DiscoveryAdapter['layer'],
  provenance: DiscoveryAdapter['provenance'],
  collect: (scope: DiscoveryScope) => Promise<DiscoveryFacts>,
): DiscoveryAdapter {
  return Object.freeze({ key, version: '1.0.0', layer, provenance, collect });
}

function sourceRow(prisma: PrismaClient, tenantId: string, runId: string, sourceKey: string) {
  return prisma.discoverySourceOutcome.findUniqueOrThrow({
    where: { runId_sourceKey: { runId, sourceKey } },
  });
}

describe('discovery run and draft (004 Phase 3 US1)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaDiscoveryRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames())
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    repo = new PrismaDiscoveryRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  // ─────────────────────────── T018: first discovery, empty graph ───────────────────────────

  describe('T018: first discovery against a design-partner-like monorepo', () => {
    const TENANT_ID = '00000000-0000-0000-8000-0000000d0001';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    const gitlabComponents: ComponentCandidate[] = [
      {
        kind: 'component_candidate',
        naturalKey: 'backend',
        name: 'backend',
        componentType: 'service',
        characteristics: ['user_facing'],
        sourcePaths: ['services/backend'],
        adapterKey: 'gitlab',
        adapterVersion: '1.0.0',
      },
      {
        kind: 'component_candidate',
        naturalKey: 'frontend',
        name: 'frontend',
        componentType: 'frontend',
        characteristics: [],
        sourcePaths: ['services/frontend'],
        adapterKey: 'gitlab',
        adapterVersion: '1.0.0',
      },
      {
        kind: 'component_candidate',
        naturalKey: 'worker',
        name: 'worker',
        componentType: 'worker',
        characteristics: [],
        sourcePaths: ['services/worker'],
        adapterKey: 'gitlab',
        adapterVersion: '1.0.0',
      },
      {
        kind: 'component_candidate',
        naturalKey: 'shared-lib',
        name: 'shared-lib',
        componentType: 'library',
        characteristics: [],
        sourcePaths: ['libs/shared'],
        adapterKey: 'gitlab',
        adapterVersion: '1.0.0',
      },
    ];
    const gitlabRepo: RepositoryRef = {
      kind: 'repository_ref',
      projectRef: 'org/monorepo',
      defaultBranch: 'main',
      headSha: 'abc123',
      componentNaturalKeys: ['backend', 'frontend', 'worker', 'shared-lib'],
    };
    const k8sUnits: DeploymentUnitCandidate[] = [
      {
        kind: 'deployment_unit_candidate',
        naturalKey: 'k8s:prod/deployment/backend',
        environment: 'prod',
        runtimeKind: 'container',
        runtimeRef: 'deployment/backend',
        currentVersion: 'v1',
      },
      {
        kind: 'deployment_unit_candidate',
        naturalKey: 'k8s:prod/deployment/worker',
        environment: 'prod',
        runtimeKind: 'container',
        runtimeRef: 'deployment/worker',
        currentVersion: 'v1',
      },
    ];
    const now = new Date().toISOString();
    const deploysEdges: DependencyObservation[] = [
      {
        kind: 'dependency_observation',
        fromNaturalKey: 'backend',
        toNaturalKey: 'k8s:prod/deployment/backend',
        edgeType: 'deploys',
        layer: 'runtime',
        provenance: 'derived_from_runtime',
        observationCount: 1,
        firstObservedAt: now,
        lastObservedAt: now,
        windowSeconds: 3600,
      },
      {
        kind: 'dependency_observation',
        fromNaturalKey: 'worker',
        toNaturalKey: 'k8s:prod/deployment/worker',
        edgeType: 'deploys',
        layer: 'runtime',
        provenance: 'derived_from_runtime',
        observationCount: 1,
        firstObservedAt: now,
        lastObservedAt: now,
        windowSeconds: 3600,
      },
    ];
    const callsEdge: DependencyObservation = {
      kind: 'dependency_observation',
      fromNaturalKey: 'frontend',
      toNaturalKey: 'backend',
      edgeType: 'calls',
      layer: 'runtime',
      provenance: 'derived_from_trace',
      observationCount: 120,
      firstObservedAt: now,
      lastObservedAt: now,
      windowSeconds: 3600,
    };

    const sources: DiscoverySourceRequest[] = [
      {
        requested: true,
        adapter: fakeAdapter('gitlab', 'code', 'derived_from_code', async () => ({
          ...emptyFacts,
          componentCandidates: gitlabComponents,
          repositoryRefs: [gitlabRepo],
        })),
      },
      {
        requested: true,
        adapter: fakeAdapter('kubernetes', 'runtime', 'derived_from_runtime', async () => ({
          ...emptyFacts,
          deploymentUnitCandidates: k8sUnits,
          dependencyObservations: deploysEdges,
        })),
      },
      {
        requested: true,
        adapter: fakeAdapter('otel', 'runtime', 'derived_from_trace', async () => ({
          ...emptyFacts,
          dependencyObservations: [callsEdge],
        })),
      },
    ];

    async function graphRowDump() {
      return {
        nodes: await prisma.graphNode.findMany({ where: { tenantId: TENANT_ID } }),
        edges: await prisma.graphEdge.findMany({ where: { tenantId: TENANT_ID } }),
        provenance: await prisma.edgeProvenance.findMany({ where: { tenantId: TENANT_ID } }),
        versions: await prisma.graphVersion.findMany({ where: { tenantId: TENANT_ID } }),
      };
    }

    it('produces a draft whose items are all proposed, leaving the graph byte-identical', async () => {
      const before = await graphRowDump();

      const draft = await withCorrelation('corr-t018', () =>
        runDiscovery(repo, CONTEXT, {
          trigger: 'onboarding',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 5000,
          itemCap: 1000,
        }),
      );

      expect(draft).not.toBeNull();
      const after = await graphRowDump();
      expect(after).toEqual(before);
      expect(after.nodes).toHaveLength(0);
      expect(after.edges).toHaveLength(0);

      const items = await prisma.draftItem.findMany({
        where: { tenantId: TENANT_ID, draftId: draft!.draftId },
      });
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.state === 'proposed')).toBe(true);

      // 7 nodes (4 components + 1 repository + 2 deployment units) + 7 edges (4 built_from + 2
      // deploys + 1 calls).
      expect(items.filter((i) => i.op === 'add_node')).toHaveLength(7);
      expect(items.filter((i) => i.op === 'add_edge')).toHaveLength(7);

      // Every draft item's observation_ref resolves to a graph_fact evidence row produced by
      // 'architecture.discovery' (FR-027).
      for (const item of items) {
        expect(item.observationRef).not.toBeNull();
        const evidence = await prisma.evidence.findUniqueOrThrow({
          where: { id_tenantId: { id: item.observationRef!, tenantId: TENANT_ID } },
        });
        expect(evidence.type).toBe('graph_fact');
        expect(evidence.producedByStep).toBe('architecture.discovery');
        expect(evidence.issueId).toBeNull();
      }
    });
  });

  // ─────────────────────── T020: the draft as a diff, against a seeded graph ───────────────────────

  describe('T020: diff against an empty graph vs a seeded confirmed graph', () => {
    const TENANT_ID = '00000000-0000-0000-8000-0000000d0002';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('every item is add_* against an empty graph (R-07: first run and re-run are one code path)', async () => {
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('gitlab-empty', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: [
              {
                kind: 'component_candidate',
                naturalKey: 'solo',
                name: 'solo',
                componentType: 'service',
                characteristics: [],
                sourcePaths: [],
                adapterKey: 'gitlab-empty',
                adapterVersion: '1.0.0',
              },
            ],
          })),
        },
      ];
      const draft = await withCorrelation('corr-t020-empty', () =>
        runDiscovery(repo, CONTEXT, {
          trigger: 'onboarding',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 5000,
          itemCap: 1000,
        }),
      );
      const items = await prisma.draftItem.findMany({
        where: { tenantId: TENANT_ID, draftId: draft!.draftId },
      });
      expect(items.every((i) => i.op === 'add_node')).toBe(true);
    });

    it('against a seeded confirmed graph: add_node, modify_attributes, mark_removed and no-item all appear', async () => {
      // Seed a confirmed graph directly (as real confirmation — sub-batch B — is not built yet).
      await prisma.graphVersion.create({
        data: {
          id: randomUUID(),
          tenantId: TENANT_ID,
          version: 1,
          mintedBy: 'confirmation',
          actorRef: 'seed-script',
        },
      });

      const legacyId = randomUUID();
      const backendId = randomUUID();
      const unchangedId = randomUUID();
      await prisma.graphNode.createMany({
        data: [
          {
            id: legacyId,
            tenantId: TENANT_ID,
            nodeKind: 'component',
            layer: 'code',
            name: 'legacy-svc',
            naturalKey: 'legacy-svc',
            provenance: 'derived_from_code',
            strength: 30,
            confidence: 60,
            state: 'confirmed',
            observationRef: randomUUID(),
            validFromVersion: 1,
          },
          {
            id: backendId,
            tenantId: TENANT_ID,
            nodeKind: 'component',
            layer: 'code',
            name: 'backend',
            naturalKey: 'backend',
            provenance: 'derived_from_code',
            strength: 30,
            confidence: 60,
            state: 'confirmed',
            observationRef: randomUUID(),
            validFromVersion: 1,
          },
          {
            id: unchangedId,
            tenantId: TENANT_ID,
            nodeKind: 'component',
            layer: 'code',
            name: 'unchanged-svc',
            naturalKey: 'unchanged-svc',
            provenance: 'derived_from_code',
            strength: 30,
            confidence: 60,
            state: 'confirmed',
            observationRef: randomUUID(),
            validFromVersion: 1,
          },
        ],
      });
      await prisma.componentAttr.createMany({
        data: [
          {
            nodeId: legacyId,
            tenantId: TENANT_ID,
            componentType: 'service',
            characteristics: [],
            ownerRef: null,
          },
          {
            nodeId: backendId,
            tenantId: TENANT_ID,
            componentType: 'service',
            characteristics: ['old_characteristic'],
            ownerRef: null,
          },
          {
            nodeId: unchangedId,
            tenantId: TENANT_ID,
            componentType: 'service',
            characteristics: [],
            ownerRef: null,
          },
        ],
      });
      const edgeId = randomUUID();
      await prisma.graphEdge.create({
        data: {
          id: edgeId,
          tenantId: TENANT_ID,
          fromNodeId: legacyId,
          toNodeId: backendId,
          edgeType: 'depends_on',
          layer: 'code',
          provenance: 'derived_from_code',
          strength: 30,
          confidence: 60,
          state: 'confirmed',
          validFromVersion: 1,
        },
      });
      await prisma.edgeProvenance.create({
        data: {
          id: randomUUID(),
          tenantId: TENANT_ID,
          edgeId,
          provenance: 'derived_from_code',
          strength: 30,
          confidence: 60,
          observationRef: randomUUID(),
          adapterKey: 'gitlab-seed',
          adapterVersion: '1.0.0',
        },
      });

      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('gitlab-seed', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: [
              {
                kind: 'component_candidate',
                naturalKey: 'backend',
                name: 'backend',
                componentType: 'service',
                characteristics: ['new_characteristic'],
                sourcePaths: [],
                adapterKey: 'gitlab-seed',
                adapterVersion: '1.0.0',
              },
              {
                kind: 'component_candidate',
                naturalKey: 'unchanged-svc',
                name: 'unchanged-svc',
                componentType: 'service',
                characteristics: [],
                sourcePaths: [],
                adapterKey: 'gitlab-seed',
                adapterVersion: '1.0.0',
              },
              {
                kind: 'component_candidate',
                naturalKey: 'new-svc',
                name: 'new-svc',
                componentType: 'service',
                characteristics: [],
                sourcePaths: [],
                adapterKey: 'gitlab-seed',
                adapterVersion: '1.0.0',
              },
            ],
          })),
        },
      ];

      const before = await prisma.graphNode.findMany({ where: { tenantId: TENANT_ID } });
      const draft = await withCorrelation('corr-t020-seeded', () =>
        runDiscovery(repo, CONTEXT, {
          trigger: 'manual',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 5000,
          itemCap: 1000,
        }),
      );
      const after = await prisma.graphNode.findMany({ where: { tenantId: TENANT_ID } });
      expect(after).toEqual(before); // discovery never writes graph_node directly (FR-009)

      const items = await prisma.draftItem.findMany({
        where: { tenantId: TENANT_ID, draftId: draft!.draftId },
      });
      // Only `add_node`/`modify_attributes` carry a top-level `naturalKey` on `proposed`;
      // `mark_removed` nests its target's key under `target` (node) or `target.from`/`target.to`
      // (edge) — exactly why a substring search on the serialised JSON is unsafe here: `backend`
      // is also an edge endpoint below (the legacy-svc -> backend mark_removed edge).
      const nodeItemFor = (nk: string) =>
        items.find((i) => (i.proposed as { naturalKey?: string }).naturalKey === nk);

      expect(nodeItemFor('new-svc')?.op).toBe('add_node');
      expect(nodeItemFor('backend')?.op).toBe('modify_attributes');
      expect(nodeItemFor('backend')?.targetNodeId).toBe(backendId);
      expect(nodeItemFor('unchanged-svc')).toBeUndefined(); // matched, unchanged -> no item

      const markRemoved = items.filter((i) => i.op === 'mark_removed');
      // legacy-svc (node) and the legacy-svc->backend edge: gitlab-seed ran `collected` and
      // re-emitted `backend`/`unchanged-svc`/`new-svc` as components but never `legacy-svc`, and
      // never re-observed the edge either.
      expect(markRemoved.some((i) => i.targetNodeId === legacyId)).toBe(true);
      expect(markRemoved.some((i) => i.targetEdgeId === edgeId)).toBe(true);
    });
  });

  // ──────────────────────────────── T019: per-source outcomes ────────────────────────────────

  describe("T019: per-source outcomes recorded per 003's statuses/reason codes", () => {
    const TENANT_ID = '00000000-0000-0000-8000-0000000d0003';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('throw -> unavailable/source_unreachable; timeout -> timed_out/timeout; not requested -> not_attempted; and the draft is still produced', async () => {
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('throws', 'code', 'derived_from_code', async () => {
            throw new Error('boom');
          }),
        },
        {
          requested: true,
          adapter: fakeAdapter(
            'slow',
            'code',
            'derived_from_code',
            (scope) =>
              new Promise((_, reject) => {
                scope.signal?.addEventListener('abort', () => reject(new Error('aborted')));
              }),
          ),
        },
        {
          requested: false,
          adapter: fakeAdapter(
            'not-requested',
            'code',
            'derived_from_code',
            async () => emptyFacts,
          ),
        },
        {
          requested: true,
          adapter: fakeAdapter('working', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: [
              {
                kind: 'component_candidate',
                naturalKey: 'only-one',
                name: 'only-one',
                componentType: 'service',
                characteristics: [],
                sourcePaths: [],
                adapterKey: 'working',
                adapterVersion: '1.0.0',
              },
            ],
          })),
        },
      ];

      const draft = await withCorrelation('corr-t019', () =>
        runDiscovery(repo, CONTEXT, {
          trigger: 'onboarding',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 100,
          itemCap: 1000,
        }),
      );
      expect(draft).not.toBeNull(); // the draft is still produced (FR-023)

      const draftRow = await prisma.discoveryDraft.findUniqueOrThrow({
        where: { id_tenantId: { id: draft!.draftId, tenantId: TENANT_ID } },
      });
      const run = await prisma.discoveryRun.findUniqueOrThrow({
        where: { id_tenantId: { id: draftRow.runId, tenantId: TENANT_ID } },
      });
      expect(run.outcome).toBe('partial');

      expect((await sourceRow(prisma, TENANT_ID, run.id, 'throws')).status).toBe('unavailable');
      expect((await sourceRow(prisma, TENANT_ID, run.id, 'throws')).reasonCode).toBe(
        'source_unreachable',
      );
      expect((await sourceRow(prisma, TENANT_ID, run.id, 'slow')).status).toBe('timed_out');
      expect((await sourceRow(prisma, TENANT_ID, run.id, 'slow')).reasonCode).toBe('timeout');
      expect((await sourceRow(prisma, TENANT_ID, run.id, 'not-requested')).status).toBe(
        'not_attempted',
      );
      expect((await sourceRow(prisma, TENANT_ID, run.id, 'working')).status).toBe('collected');

      // One collection_gap evidence row per non-collected source (3: throws, slow, not-requested).
      const gaps = await prisma.evidence.findMany({
        where: { tenantId: TENANT_ID, type: 'collection_gap', sourceRef: run.id },
      });
      expect(gaps).toHaveLength(3);
      expect(gaps.map((g) => g.sourceSystem).sort()).toEqual(['not-requested', 'slow', 'throws']);
    });

    it('a fully empty source is collected/empty_result, not partial', async () => {
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('empty-and-working', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: [
              {
                kind: 'component_candidate',
                naturalKey: 'x',
                name: 'x',
                componentType: 'service',
                characteristics: [],
                sourcePaths: [],
                adapterKey: 'empty-and-working',
                adapterVersion: '1.0.0',
              },
            ],
          })),
        },
        {
          requested: true,
          adapter: fakeAdapter('truly-empty', 'code', 'derived_from_code', async () => emptyFacts),
        },
      ];
      const draft = await withCorrelation('corr-t019b', () =>
        runDiscovery(repo, CONTEXT, {
          trigger: 'manual',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 5000,
          itemCap: 1000,
        }),
      );
      const runId = (
        await prisma.discoveryDraft.findUniqueOrThrow({
          where: { id_tenantId: { id: draft!.draftId, tenantId: TENANT_ID } },
        })
      ).runId;
      const row = await sourceRow(prisma, TENANT_ID, runId, 'truly-empty');
      expect(row.status).toBe('collected');
      expect(row.reasonCode).toBe('empty_result');
    });
  });

  // ──────────────────────────────────── T032: unparsable region ────────────────────────────────────

  describe('T032: an unparsable region produces a collection_gap, draft still produced from the rest', () => {
    const TENANT_ID = '00000000-0000-0000-8000-0000000d0004';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('source outcome partial, one collection_gap naming the region, the rest of the draft intact', async () => {
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('gitlab-partial', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: [
              {
                kind: 'component_candidate',
                naturalKey: 'parsable-svc',
                name: 'parsable-svc',
                componentType: 'service',
                characteristics: [],
                sourcePaths: [],
                adapterKey: 'gitlab-partial',
                adapterVersion: '1.0.0',
              },
            ],
            collectionGaps: [
              {
                kind: 'collection_gap',
                what: 'vendor/weird-format/',
                why: 'unparsable manifest',
                withheldByRedaction: false,
              },
            ],
          })),
        },
      ];
      const draft = await withCorrelation('corr-t032', () =>
        runDiscovery(repo, CONTEXT, {
          trigger: 'manual',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 5000,
          itemCap: 1000,
        }),
      );
      const runId = (
        await prisma.discoveryDraft.findUniqueOrThrow({
          where: { id_tenantId: { id: draft!.draftId, tenantId: TENANT_ID } },
        })
      ).runId;
      const row = await sourceRow(prisma, TENANT_ID, runId, 'gitlab-partial');
      expect(row.status).toBe('partial');
      expect(row.reasonCode).toBeNull();

      const gap = await prisma.evidence.findFirstOrThrow({
        where: {
          tenantId: TENANT_ID,
          type: 'collection_gap',
          sourceRef: runId,
          sourceSystem: 'gitlab-partial',
        },
      });
      expect(gap.payload).toMatchObject({
        what: 'vendor/weird-format/',
        why: 'unparsable manifest',
      });

      const items = await prisma.draftItem.findMany({
        where: { tenantId: TENANT_ID, draftId: draft!.draftId },
      });
      expect(items.some((i) => JSON.stringify(i.proposed).includes('parsable-svc'))).toBe(true);
    });
  });

  // ─────────────────────────────── T021: parallel, bounded, cancellable ───────────────────────────────

  describe('T021: RunDiscovery is parallel, bounded and cancellable', () => {
    const TENANT_ID = '00000000-0000-0000-8000-0000000d0005';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('runs every adapter in parallel — proven by a shared barrier, no sleeps', async () => {
      let started = 0;
      let resolveBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => (resolveBarrier = resolve));
      const arriveAndWait = async (): Promise<DiscoveryFacts> => {
        started += 1;
        if (started === 2) resolveBarrier();
        await barrier;
        return emptyFacts;
      };
      const sources: DiscoverySourceRequest[] = [
        { requested: true, adapter: fakeAdapter('a', 'code', 'derived_from_code', arriveAndWait) },
        { requested: true, adapter: fakeAdapter('b', 'code', 'derived_from_code', arriveAndWait) },
      ];
      // If collection were sequential, 'b' would never be called before 'a' resolves, 'a' would
      // never see started === 2, and this would hang until the test's own timeout.
      const results = await collectDiscovery(sources, {
        tenantId: TENANT_ID,
        runnerId: 'runner-1',
        perSourceTimeoutMs: 5000,
        itemCap: 1000,
      });
      expect(results).toHaveLength(2);
      expect(started).toBe(2);
    });

    it('bounds item count at the cap and marks the source partial', async () => {
      const many: ComponentCandidate[] = Array.from({ length: 10 }, (_, i) => ({
        kind: 'component_candidate',
        naturalKey: `svc-${i}`,
        name: `svc-${i}`,
        componentType: 'service',
        characteristics: [],
        sourcePaths: [],
        adapterKey: 'bounded',
        adapterVersion: '1.0.0',
      }));
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('bounded', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: many,
          })),
        },
      ];
      const results = await collectDiscovery(sources, {
        tenantId: TENANT_ID,
        runnerId: 'runner-1',
        perSourceTimeoutMs: 5000,
        itemCap: 3,
      });
      expect(results[0]!.items).toHaveLength(3);
      expect(results[0]!.status).toBe('partial');
    });

    it('a per-source timeout does not hang the whole run', async () => {
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter(
            'hangs',
            'code',
            'derived_from_code',
            (scope) =>
              new Promise((_, reject) => {
                scope.signal?.addEventListener('abort', () => reject(new Error('aborted')));
              }),
          ),
        },
      ];
      const results = await collectDiscovery(sources, {
        tenantId: TENANT_ID,
        runnerId: 'runner-1',
        perSourceTimeoutMs: 50,
        itemCap: 1000,
      });
      expect(results[0]!.status).toBe('timed_out');
    });

    it('aborting mid-collection throws, and no draft is written, run not marked complete', async () => {
      const controller = new AbortController();
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter(
            'never-resolves',
            'code',
            'derived_from_code',
            () => new Promise(() => {}),
          ),
        },
      ];
      const promise = withCorrelation('corr-t021-abort', () =>
        runDiscovery(repo, CONTEXT, {
          trigger: 'manual',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 60_000,
          itemCap: 1000,
          signal: controller.signal,
        }),
      );
      queueMicrotask(() => controller.abort());
      await expect(promise).rejects.toThrow();

      const runs = await prisma.discoveryRun.findMany({ where: { tenantId: TENANT_ID } });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.finishedAt).toBeNull();
      const drafts = await prisma.discoveryDraft.findMany({ where: { tenantId: TENANT_ID } });
      expect(drafts).toHaveLength(0);
    });

    it('the DiscoveryAdapter port is structurally read-only — no method but collect()', () => {
      const adapter = fakeAdapter('ro', 'code', 'derived_from_code', async () => emptyFacts);
      const methods = Object.keys(adapter).filter(
        (k) => typeof (adapter as unknown as Record<string, unknown>)[k] === 'function',
      );
      expect(methods).toEqual(['collect']);
    });
  });

  // ───────────────────────── T023 (ingestion side): the rejection filter ─────────────────────────

  describe('T023: proposal_rejection filters a candidate before its draft item is written', () => {
    const TENANT_ID = '00000000-0000-0000-8000-0000000d0006';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('a rejected digest is never re-raised, even though its confidence would differ', async () => {
      const candidate: ComponentCandidate = {
        kind: 'component_candidate',
        naturalKey: 'rejected-svc',
        name: 'rejected-svc',
        componentType: 'service',
        characteristics: [],
        sourcePaths: [],
        adapterKey: 'gitlab-reject',
        adapterVersion: '1.0.0',
      };
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('gitlab-reject', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: [candidate],
          })),
        },
      ];

      // The real `proposalDigest` over the exact proposal the diff builder would construct for
      // this candidate (add_node, component, this natural key, these normalised attributes) —
      // not a hand-rolled hash, so this test can never drift from what the production code hashes.
      const digest = proposalDigest({
        op: 'add_node',
        nodeKind: 'component',
        naturalKey: 'rejected-svc',
        name: 'rejected-svc',
        attributes: { componentType: 'service', characteristics: [], ownerRef: null },
      });
      await prisma.proposalRejection.create({
        data: {
          tenantId: TENANT_ID,
          proposalDigest: digest,
          rejectedBy: 'human:alice',
          reason: 'not relevant',
        },
      });

      const draft = await withCorrelation('corr-t023', () =>
        runDiscovery(repo, CONTEXT, {
          trigger: 'manual',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 5000,
          itemCap: 1000,
        }),
      );
      if (draft !== null) {
        const items = await prisma.draftItem.findMany({
          where: { tenantId: TENANT_ID, draftId: draft.draftId },
        });
        expect(items.some((i) => JSON.stringify(i.proposed).includes('rejected-svc'))).toBe(false);
      }
    });
  });

  // ──────────────────────────────── Adapter-constant cross-check ────────────────────────────────

  describe('Ingestion rules: the adapter-constant cross-check', () => {
    const TENANT_ID = '00000000-0000-0000-8000-0000000d0008';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('a component_candidate claiming a different adapterKey than its source is dropped, and the source is downgraded', async () => {
      const impostor: ComponentCandidate = {
        kind: 'component_candidate',
        naturalKey: 'impostor-svc',
        name: 'impostor-svc',
        componentType: 'service',
        characteristics: [],
        sourcePaths: [],
        adapterKey: 'someone-else', // does not match the source it actually arrived under
        adapterVersion: '1.0.0',
      };
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('gitlab-xcheck', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: [impostor],
          })),
        },
      ];
      const draft = await withCorrelation('corr-xcheck', () =>
        runDiscovery(repo, CONTEXT, {
          trigger: 'manual',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 5000,
          itemCap: 1000,
        }),
      );
      // Nothing else was offered this run, so the only item is dropped and the run is `failed`
      // (plan: "failed if none returned any item") — no draft is written.
      expect(draft).toBeNull();

      const runs = await prisma.discoveryRun.findMany({ where: { tenantId: TENANT_ID } });
      const row = await sourceRow(prisma, TENANT_ID, runs[0]!.id, 'gitlab-xcheck');
      expect(row.status).toBe('partial');
      expect(row.reasonCode).toBe('schema_rejected');
      expect(row.itemCount).toBe(0);
    });
  });

  // ───────────────────────────────────── Idempotency ─────────────────────────────────────

  describe('Idempotency: ingesting the same batch twice', () => {
    const TENANT_ID = '00000000-0000-0000-8000-0000000d0007';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('produces one draft and no duplicate evidence', async () => {
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('gitlab-idem', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: [
              {
                kind: 'component_candidate',
                naturalKey: 'idem-svc',
                name: 'idem-svc',
                componentType: 'service',
                characteristics: [],
                sourcePaths: [],
                adapterKey: 'gitlab-idem',
                adapterVersion: '1.0.0',
              },
            ],
          })),
        },
      ];

      const run = await withCorrelation('corr-idem-start', () =>
        startDiscoveryRun(repo, CONTEXT, { trigger: 'manual', runnerId: 'runner-1' }),
      );
      const collected = await collectDiscovery(sources, {
        tenantId: TENANT_ID,
        runnerId: 'runner-1',
        perSourceTimeoutMs: 5000,
        itemCap: 1000,
      });
      const adapterConstants = {
        'gitlab-idem': {
          version: '1.0.0',
          layer: 'code' as const,
          provenance: 'derived_from_code' as const,
        },
      };

      const first = await withCorrelation('corr-idem-1', () =>
        ingestDiscoveryBatch(repo, CONTEXT, {
          runId: run.id,
          baseVersion: run.baseVersion,
          sources: collected,
          adapterConstants,
        }),
      );
      const second = await withCorrelation('corr-idem-2', () =>
        ingestDiscoveryBatch(repo, CONTEXT, {
          runId: run.id,
          baseVersion: run.baseVersion,
          sources: collected,
          adapterConstants,
        }),
      );

      expect(second!.draftId).toBe(first!.draftId);
      expect(second!.itemIds).toEqual(first!.itemIds);

      const drafts = await prisma.discoveryDraft.findMany({
        where: { tenantId: TENANT_ID, runId: run.id },
      });
      expect(drafts).toHaveLength(1);
      const evidenceCount = await prisma.evidence.count({
        where: { tenantId: TENANT_ID, sourceRef: run.id },
      });
      const items = await prisma.draftItem.findMany({
        where: { tenantId: TENANT_ID, draftId: first!.draftId },
      });
      expect(items).toHaveLength(1);

      // A third ingest, same run: still one draft, same evidence count (no duplicates).
      await withCorrelation('corr-idem-3', () =>
        ingestDiscoveryBatch(repo, CONTEXT, {
          runId: run.id,
          baseVersion: run.baseVersion,
          sources: collected,
          adapterConstants,
        }),
      );
      expect(
        await prisma.evidence.count({ where: { tenantId: TENANT_ID, sourceRef: run.id } }),
      ).toBe(evidenceCount);
    });
  });
});
