import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  type DependencyObservation,
  type DiscoveryAdapter,
  type DiscoveryFacts,
  type DiscoveryScope,
  type DiscoverySourceRequest,
  PrismaDiscoveryRepository,
  PrismaDraftReviewRepository,
  confirmDraftItems,
  rejectDraftItems,
  runDiscovery,
} from '@healer/domain-architecture';
import { TenantContext, withCorrelation } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 004 Phase 3 US1 (T025-T029): confirm/reject is the only writer of `state = 'confirmed'`
 * (T026), human-actor-only (T025, FR-010), rebased against the live graph before applying
 * (T027/T028, R-07), and never overwrites a confirmed element even when a later run contradicts
 * it (T029, FR-012, SC-003). One shared Postgres container across every scenario, each using its
 * own tenant id.
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

describe('confirm/reject draft items (004 Phase 3 US1, T025-T029)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let discoveryRepo: PrismaDiscoveryRepository;
  let reviewRepo: PrismaDraftReviewRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames())
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    discoveryRepo = new PrismaDiscoveryRepository(prisma);
    reviewRepo = new PrismaDraftReviewRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  /** A bare `discovery_run` + `discovery_draft` row to hang `draft_item` rows off — the review
   *  flow's own concern starts at the draft, not at a real collection run, so every scenario
   *  below seeds state directly rather than running `runDiscovery` (T018-T023's own tests already
   *  cover the collection path; T029 is the one scenario that genuinely needs a real run, and it
   *  seeds its own). */
  async function seedDraft(
    tenantId: string,
    baseVersion = 0,
  ): Promise<{ runId: string; draftId: string }> {
    const runId = randomUUID();
    await prisma.discoveryRun.create({
      data: {
        id: runId,
        tenantId,
        baseVersion,
        trigger: 'manual',
        runnerId: 'runner-1',
        startedAt: new Date(),
        finishedAt: new Date(),
        outcome: 'complete',
      },
    });
    const draftId = randomUUID();
    await prisma.discoveryDraft.create({
      data: { id: draftId, tenantId, runId, baseVersion, state: 'open' },
    });
    return { runId, draftId };
  }

  async function seedAddNodeItem(
    tenantId: string,
    draftId: string,
    naturalKey: string,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.draftItem.create({
      data: {
        id,
        tenantId,
        draftId,
        op: 'add_node',
        proposed: {
          op: 'add_node',
          nodeKind: 'component',
          naturalKey,
          name: naturalKey,
          attributes: { componentType: 'service', characteristics: [], ownerRef: null },
        },
        current: undefined,
        proposalDigest: `digest-${naturalKey}-${id}`,
        provenance: 'derived_from_code',
        strength: 30,
        confidence: 60,
        observationRef: randomUUID(),
        state: 'proposed',
      },
    });
    return id;
  }

  /** A confirmed, live component node — the baseline T027/T028's supersede check rebases
   *  against. Mirrors `discovery-run.e2e.test.ts`'s T020 seeding exactly. */
  async function seedConfirmedComponent(
    tenantId: string,
    naturalKey: string,
    characteristics: readonly string[] = [],
  ): Promise<string> {
    const id = randomUUID();
    await prisma.graphNode.create({
      data: {
        id,
        tenantId,
        nodeKind: 'component',
        layer: 'code',
        name: naturalKey,
        naturalKey,
        provenance: 'derived_from_code',
        strength: 30,
        confidence: 60,
        state: 'confirmed',
        observationRef: randomUUID(),
        validFromVersion: 1,
      },
    });
    await prisma.componentAttr.create({
      data: {
        nodeId: id,
        tenantId,
        componentType: 'service',
        characteristics: [...characteristics],
        ownerRef: null,
      },
    });
    return id;
  }

  async function seedModifyAttributesItem(
    tenantId: string,
    draftId: string,
    naturalKey: string,
    targetNodeId: string,
    currentCharacteristics: readonly string[],
    proposedCharacteristics: readonly string[],
  ): Promise<string> {
    const id = randomUUID();
    await prisma.draftItem.create({
      data: {
        id,
        tenantId,
        draftId,
        op: 'modify_attributes',
        targetNodeId,
        proposed: {
          op: 'modify_attributes',
          nodeKind: 'component',
          naturalKey,
          name: naturalKey,
          attributes: {
            componentType: 'service',
            characteristics: [...proposedCharacteristics],
            ownerRef: null,
          },
        },
        current: {
          name: naturalKey,
          attributes: {
            componentType: 'service',
            characteristics: [...currentCharacteristics],
            ownerRef: null,
          },
        },
        proposalDigest: `digest-modify-${naturalKey}-${id}`,
        provenance: 'derived_from_code',
        strength: 30,
        confidence: 60,
        observationRef: randomUUID(),
        state: 'proposed',
      },
    });
    return id;
  }

  // ───────────────────────────────── T025: human-actor gate ─────────────────────────────────

  describe('T025: confirmation refuses a non-human actor and audits the attempt', () => {
    const TENANT_ID = '00000000-0000-0000-8000-000000002501';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('403 HUMAN_ACTOR_REQUIRED for an agent credential, with nothing applied and an audit entry recording the attempt', async () => {
      const { draftId } = await seedDraft(TENANT_ID);
      const itemId = await seedAddNodeItem(TENANT_ID, draftId, 'agent-attempt-svc');

      const agentRunId = randomUUID();
      await expect(
        withCorrelation('corr-t025-confirm', () =>
          confirmDraftItems(reviewRepo, CONTEXT, {
            draftId,
            itemIds: [itemId],
            actor: { actorType: 'agent', actorRef: 'agent:bot-1', agentRunId },
            reason: 'automated attempt',
          }),
        ),
      ).rejects.toMatchObject({ code: 'HUMAN_ACTOR_REQUIRED' });

      const item = await prisma.draftItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.state).toBe('proposed'); // nothing applied
      expect(await prisma.graphNode.count({ where: { tenantId: TENANT_ID } })).toBe(0);
      expect(await prisma.graphVersion.count({ where: { tenantId: TENANT_ID } })).toBe(0);

      const audits = await prisma.auditEntry.findMany({
        where: { tenantId: TENANT_ID, targetType: 'draft_item', targetId: draftId },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorType).toBe('agent');
      expect(audits[0]!.actorRef).toBe('agent:bot-1');
      expect(audits[0]!.agentRunId).toBe(agentRunId);
      expect(audits[0]!.outcome).toBe('refused');
      expect(audits[0]!.action).toBe('architecture.draft_item.confirm');
    });

    it('the same gate refuses rejection too (FR-010 covers both)', async () => {
      const { draftId } = await seedDraft(TENANT_ID);
      const itemId = await seedAddNodeItem(TENANT_ID, draftId, 'agent-reject-attempt-svc');

      await expect(
        withCorrelation('corr-t025-reject', () =>
          rejectDraftItems(reviewRepo, CONTEXT, {
            draftId,
            itemIds: [itemId],
            actor: { actorType: 'runner', actorRef: 'runner:ci-1' },
            reason: 'automated attempt',
          }),
        ),
      ).rejects.toMatchObject({ code: 'HUMAN_ACTOR_REQUIRED' });

      const item = await prisma.draftItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.state).toBe('proposed');
    });
  });

  // ──────────────────── T026: ConfirmDraftItems / RejectDraftItems ────────────────────

  describe('T026: one serialised transaction, exactly one graph_version, before/after audited', () => {
    const TENANT_ID = '00000000-0000-0000-8000-000000002601';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('confirms two items in one call: one graph_version, both graph rows, both draft items backfilled, before/after audited, GraphVersionPublished enqueued once', async () => {
      const { draftId } = await seedDraft(TENANT_ID);
      const nodeItemId = await seedAddNodeItem(TENANT_ID, draftId, 'two-item-svc-a');
      const nodeItemId2 = await seedAddNodeItem(TENANT_ID, draftId, 'two-item-svc-b');

      const result = await withCorrelation('corr-t026-confirm', () =>
        confirmDraftItems(reviewRepo, CONTEXT, {
          draftId,
          itemIds: [nodeItemId, nodeItemId2],
          actor: { actorType: 'human', actorRef: 'human:alice' },
          reason: 'looks right',
        }),
      );

      expect(result.version).toBe(1);
      expect(result.confirmedItems).toHaveLength(2);

      const versions = await prisma.graphVersion.findMany({ where: { tenantId: TENANT_ID } });
      expect(versions).toHaveLength(1); // exactly one version for the whole batch
      expect(versions[0]!.mintedBy).toBe('confirmation');
      expect(versions[0]!.actorRef).toBe('human:alice');
      expect(versions[0]!.draftId).toBe(draftId);

      const nodes = await prisma.graphNode.findMany({
        where: { tenantId: TENANT_ID },
        orderBy: { naturalKey: 'asc' },
      });
      expect(nodes).toHaveLength(2);
      for (const node of nodes) {
        expect(node.provenance).toBe('human_confirmed');
        expect(node.state).toBe('confirmed');
        expect(node.actorRef).toBe('human:alice');
        expect(node.validFromVersion).toBe(1);
      }

      const items = await prisma.draftItem.findMany({ where: { tenantId: TENANT_ID, draftId } });
      for (const item of items) {
        expect(item.state).toBe('confirmed');
        expect(item.decidedBy).toBe('human:alice');
        expect(item.decidedAt).not.toBeNull();
        expect(item.targetNodeId).not.toBeNull(); // backfilled on a confirmed add_node (T026/T038 note)
      }

      const audits = await prisma.auditEntry.findMany({
        where: { tenantId: TENANT_ID, action: 'architecture.draft_item.confirm', outcome: 'ok' },
      });
      expect(audits).toHaveLength(2);
      for (const audit of audits) {
        expect(audit.graphVersion).toBe(1);
        expect(audit.before).toBeNull(); // add_node: nothing existed before
        expect(audit.after).not.toBeNull();
      }

      const outboxRows = await prisma.outbox.findMany({
        where: { tenantId: TENANT_ID, name: 'GraphVersionPublished' },
      });
      expect(outboxRows).toHaveLength(1); // one event for the whole batch, not per item
    });

    it('an add_edge in the same batch as its add_node resolves against the node just confirmed', async () => {
      const { draftId } = await seedDraft(TENANT_ID);
      const fromId = await seedAddNodeItem(TENANT_ID, draftId, 'batch-from-svc');
      const toId = await seedAddNodeItem(TENANT_ID, draftId, 'batch-to-svc');
      const edgeItemId = randomUUID();
      await prisma.draftItem.create({
        data: {
          id: edgeItemId,
          tenantId: TENANT_ID,
          draftId,
          op: 'add_edge',
          proposed: {
            op: 'add_edge',
            from: { nodeKind: 'component', naturalKey: 'batch-from-svc' },
            to: { nodeKind: 'component', naturalKey: 'batch-to-svc' },
            edgeType: 'depends_on',
            layer: 'code',
          },
          current: undefined,
          proposalDigest: `digest-edge-${edgeItemId}`,
          provenance: 'derived_from_code',
          strength: 30,
          confidence: 60,
          observationRef: randomUUID(),
          state: 'proposed',
        },
      });

      const result = await withCorrelation('corr-t026-batch-edge', () =>
        confirmDraftItems(reviewRepo, CONTEXT, {
          draftId,
          itemIds: [fromId, toId, edgeItemId],
          actor: { actorType: 'human', actorRef: 'human:bob' },
          reason: 'same-batch dependency',
        }),
      );
      expect(result.confirmedItems).toHaveLength(3);

      const edges = await prisma.graphEdge.findMany({ where: { tenantId: TENANT_ID } });
      expect(edges).toHaveLength(1);
      expect(edges[0]!.provenance).toBe('human_confirmed');
      expect(edges[0]!.actorRef).toBe('human:bob');

      // C-87 (004 reconciliation batch (a)+(b)): a confirmed edge keeps BOTH the machine
      // observation `mergeObservationInTx` wrote (the draft item's own `derived_from_code`,
      // unchanged by confirmation) AND a separate human-confirmation row with a real `actor_ref`
      // — T011's MAX-over-`edge_provenance` invariant still resolves `graph_edge`'s own
      // provenance/strength/confidence to the human row, since `human_confirmed` outranks every
      // machine class.
      const provenanceRows = await prisma.edgeProvenance.findMany({
        where: { tenantId: TENANT_ID, edgeId: edges[0]!.id },
        orderBy: { recordedAt: 'asc' },
      });
      expect(provenanceRows).toHaveLength(2);
      expect(provenanceRows[0]!.provenance).toBe('derived_from_code');
      expect(provenanceRows[0]!.actorRef).toBeNull();
      expect(provenanceRows[1]!.provenance).toBe('human_confirmed');
      expect(provenanceRows[1]!.actorRef).toBe('human:bob');
    });

    it('rejects a draft item: proposal_rejection written, draft_item rejected, no graph_version minted', async () => {
      const { draftId } = await seedDraft(TENANT_ID);
      const itemId = await seedAddNodeItem(TENANT_ID, draftId, 'rejected-svc-026');
      const digestRow = await prisma.draftItem.findUniqueOrThrow({ where: { id: itemId } });

      const versionsBefore = await prisma.graphVersion.count({ where: { tenantId: TENANT_ID } });

      const result = await withCorrelation('corr-t026-reject', () =>
        rejectDraftItems(reviewRepo, CONTEXT, {
          draftId,
          itemIds: [itemId],
          actor: { actorType: 'human', actorRef: 'human:carol' },
          reason: 'not relevant to this system',
        }),
      );
      expect(result.rejectedItemIds).toEqual([itemId]);

      const item = await prisma.draftItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.state).toBe('rejected');
      expect(item.decidedBy).toBe('human:carol');

      const rejection = await prisma.proposalRejection.findUniqueOrThrow({
        where: {
          tenantId_proposalDigest: {
            tenantId: TENANT_ID,
            proposalDigest: digestRow.proposalDigest,
          },
        },
      });
      expect(rejection.rejectedBy).toBe('human:carol');

      // Rejecting mints no graph_version — GraphVersion.mintedBy has no 'rejection' member.
      expect(await prisma.graphVersion.count({ where: { tenantId: TENANT_ID } })).toBe(
        versionsBefore,
      );

      const audits = await prisma.auditEntry.findMany({
        where: { tenantId: TENANT_ID, action: 'architecture.draft_item.reject' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.graphVersion).toBeNull();
    });

    it('confirming an already-decided item is a conflict, not a silent no-op', async () => {
      const { draftId } = await seedDraft(TENANT_ID);
      const itemId = await seedAddNodeItem(TENANT_ID, draftId, 'double-decide-svc');
      await withCorrelation('corr-t026-first', () =>
        confirmDraftItems(reviewRepo, CONTEXT, {
          draftId,
          itemIds: [itemId],
          actor: { actorType: 'human', actorRef: 'human:dave' },
          reason: 'first pass',
        }),
      );

      await expect(
        withCorrelation('corr-t026-second', () =>
          confirmDraftItems(reviewRepo, CONTEXT, {
            draftId,
            itemIds: [itemId],
            actor: { actorType: 'human', actorRef: 'human:dave' },
            reason: 'second pass',
          }),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    // Review guidance: prove the version race with a held-open transaction polled through
    // `pg_stat_activity`, never `sleep` — same technique as `discovery-ingest-race.e2e.test.ts`
    // and `graph-node-rename-race.e2e.test.ts`.
    it('a genuine concurrent attempt to mint the same version is detected at the database level, not silently double-applied', async () => {
      // Its own tenant, not `TENANT_ID` — every other test in this `describe` block mints graph
      // versions against `TENANT_ID` too, and a shared tenant here would make "the next version"
      // whatever those other tests left it at, not the `1` this test hardcodes below.
      const RACE_TENANT_ID = '00000000-0000-0000-8000-000000002699';
      const RACE_CONTEXT = TenantContext.forTrustedInternalUse(RACE_TENANT_ID);
      const { draftId: draftA } = await seedDraft(RACE_TENANT_ID);
      const itemA = await seedAddNodeItem(RACE_TENANT_ID, draftA, 'race-svc-a');

      // Holds an uncommitted graph_version row at version 1 for this tenant — the exact row a
      // real confirmDraftItems call below will also try to claim.
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      let markReady!: () => void;
      const isReady = new Promise<void>((resolve) => (markReady = resolve));
      let holderPid = 0;
      const holderVersionId = randomUUID();
      const holderDone = prisma.$transaction(
        async (tx) => {
          holderPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!
            .pid;
          await tx.graphVersion.create({
            data: {
              id: holderVersionId,
              tenantId: RACE_TENANT_ID,
              version: 1,
              mintedBy: 'confirmation',
              actorRef: 'human:holder',
              note: 'race holder',
            },
          });
          markReady();
          await gate;
        },
        { timeout: 120_000, maxWait: 60_000 },
      );
      holderDone.catch(() => markReady());
      await isReady;

      const racer = withCorrelation('corr-t026-race', () =>
        confirmDraftItems(reviewRepo, RACE_CONTEXT, {
          draftId: draftA,
          itemIds: [itemA],
          actor: { actorType: 'human', actorRef: 'human:racer' },
          reason: 'racing the holder',
        }),
      );
      racer.catch(() => {});

      // Confirm genuine Postgres-level contention: the racer's own INSERT into graph_version
      // blocks on the holder's uncommitted row, visible in pg_stat_activity — not just "it was
      // slow", a real lock wait against this specific backend's open transaction.
      const deadline = Date.now() + 20_000;
      for (;;) {
        const waiting = Number(
          await query(
            pg,
            `select count(*) from pg_stat_activity w
             where w.datname = current_database() and w.wait_event_type = 'Lock'
               and w.pid <> ${holderPid}`,
          ),
        );
        if (waiting >= 1) break;
        if (Date.now() > deadline)
          throw new Error('expected the racer to block on the held version row, nothing waited');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // The holder commits first — the racer must now fail cleanly (GraphConcurrencyError,
      // translated from the real Postgres unique-violation it hits on resume), never silently
      // mint a second, duplicate version 1.
      openGate();
      await holderDone;
      await expect(racer).rejects.toMatchObject({ name: 'GraphConcurrencyError' });

      const versions = await prisma.graphVersion.findMany({
        where: { tenantId: RACE_TENANT_ID, version: 1 },
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]!.id).toBe(holderVersionId); // the holder's row — the racer's never landed
    });
  });

  // ──────────────────── T027/T028: draft rebase, superseded items ────────────────────

  describe('T027/T028: a draft item whose target moved under it is superseded, not applied', () => {
    const TENANT_ID = '00000000-0000-0000-8000-000000002701';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('409 DRAFT_ITEM_SUPERSEDED when a manual edit changed the target after the run; nothing applied', async () => {
      const nodeId = await seedConfirmedComponent(TENANT_ID, 'superseded-svc', [
        'old_characteristic',
      ]);
      const { draftId } = await seedDraft(TENANT_ID);
      const itemId = await seedModifyAttributesItem(
        TENANT_ID,
        draftId,
        'superseded-svc',
        nodeId,
        ['old_characteristic'],
        ['stateful'],
      );

      // The manual edit: someone else changed the live node's attributes after the draft was
      // built, before this confirm call runs.
      await prisma.componentAttr.update({
        where: { nodeId_tenantId: { nodeId, tenantId: TENANT_ID } },
        data: { characteristics: ['edited_by_someone_else'] },
      });

      await expect(
        withCorrelation('corr-t027-confirm', () =>
          confirmDraftItems(reviewRepo, CONTEXT, {
            draftId,
            itemIds: [itemId],
            actor: { actorType: 'human', actorRef: 'human:erin' },
            reason: 'reviewing',
          }),
        ),
      ).rejects.toMatchObject({ code: 'DRAFT_ITEM_SUPERSEDED' });

      const item = await prisma.draftItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.state).toBe('proposed'); // nothing applied
      const node = await prisma.componentAttr.findUniqueOrThrow({
        where: { nodeId_tenantId: { nodeId, tenantId: TENANT_ID } },
      });
      expect(node.characteristics).toEqual(['edited_by_someone_else']); // untouched by the refused confirm
      expect(await prisma.graphVersion.count({ where: { tenantId: TENANT_ID } })).toBe(0); // no version minted
    });

    it('confirms cleanly when the target was not touched since the run (the common case)', async () => {
      const nodeId = await seedConfirmedComponent(TENANT_ID, 'not-superseded-svc', [
        'old_characteristic',
      ]);
      const { draftId } = await seedDraft(TENANT_ID);
      const itemId = await seedModifyAttributesItem(
        TENANT_ID,
        draftId,
        'not-superseded-svc',
        nodeId,
        ['old_characteristic'],
        ['stateful'],
      );

      await withCorrelation('corr-t028-confirm', () =>
        confirmDraftItems(reviewRepo, CONTEXT, {
          draftId,
          itemIds: [itemId],
          actor: { actorType: 'human', actorRef: 'human:erin' },
          reason: 'reviewing',
        }),
      );

      const attr = await prisma.componentAttr.findUniqueOrThrow({
        where: { nodeId_tenantId: { nodeId, tenantId: TENANT_ID } },
      });
      expect(attr.characteristics).toEqual(['stateful']);
    });

    it('a batch with one superseded item applies nothing from the whole batch', async () => {
      const nodeId = await seedConfirmedComponent(TENANT_ID, 'batch-superseded-svc', []);
      const { draftId } = await seedDraft(TENANT_ID);
      const okItemId = await seedAddNodeItem(TENANT_ID, draftId, 'batch-superseded-sibling');
      const badItemId = await seedModifyAttributesItem(
        TENANT_ID,
        draftId,
        'batch-superseded-svc',
        nodeId,
        [],
        ['x'],
      );
      await prisma.componentAttr.update({
        where: { nodeId_tenantId: { nodeId, tenantId: TENANT_ID } },
        data: { characteristics: ['changed'] },
      });

      await expect(
        withCorrelation('corr-t028-batch', () =>
          confirmDraftItems(reviewRepo, CONTEXT, {
            draftId,
            itemIds: [okItemId, badItemId],
            actor: { actorType: 'human', actorRef: 'human:erin' },
            reason: 'reviewing',
          }),
        ),
      ).rejects.toMatchObject({ code: 'DRAFT_ITEM_SUPERSEDED' });

      // The sibling item, which was perfectly fine on its own, must not have been applied either.
      const okItem = await prisma.draftItem.findUniqueOrThrow({ where: { id: okItemId } });
      expect(okItem.state).toBe('proposed');
      expect(
        await prisma.graphNode.count({
          where: { tenantId: TENANT_ID, naturalKey: 'batch-superseded-sibling' },
        }),
      ).toBe(0);
    });
  });

  // ──────────────────── T029: confirmed stands, contradiction is a new draft item ────────────────────

  describe('T029: a confirmed edge is never overwritten by discovery; a contradiction surfaces as a new proposal', () => {
    const TENANT_ID = '00000000-0000-0000-8000-000000002901';
    const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

    it('confirm A->B, then a run observing B->A leaves A->B confirmed and untouched, with the contradiction as its own draft item (FR-012, SC-003)', async () => {
      // Confirm a->b depends_on through the real command, so this test also exercises the add_edge
      // write path end to end rather than hand-seeding the confirmed edge.
      const { draftId: setupDraftId } = await seedDraft(TENANT_ID);
      const aId = await seedAddNodeItem(TENANT_ID, setupDraftId, 'contradiction-a');
      const bId = await seedAddNodeItem(TENANT_ID, setupDraftId, 'contradiction-b');
      const edgeItemId = randomUUID();
      await prisma.draftItem.create({
        data: {
          id: edgeItemId,
          tenantId: TENANT_ID,
          draftId: setupDraftId,
          op: 'add_edge',
          proposed: {
            op: 'add_edge',
            from: { nodeKind: 'component', naturalKey: 'contradiction-a' },
            to: { nodeKind: 'component', naturalKey: 'contradiction-b' },
            edgeType: 'depends_on',
            layer: 'code',
          },
          current: undefined,
          proposalDigest: `digest-contradiction-edge-${edgeItemId}`,
          provenance: 'derived_from_code',
          strength: 30,
          confidence: 60,
          observationRef: randomUUID(),
          state: 'proposed',
        },
      });
      await withCorrelation('corr-t029-setup', () =>
        confirmDraftItems(reviewRepo, CONTEXT, {
          draftId: setupDraftId,
          itemIds: [aId, bId, edgeItemId],
          actor: { actorType: 'human', actorRef: 'human:frank' },
          reason: 'establishing the confirmed baseline',
        }),
      );

      const confirmedEdgeBefore = await prisma.graphEdge.findFirstOrThrow({
        where: { tenantId: TENANT_ID },
      });
      expect(confirmedEdgeBefore.state).toBe('confirmed');
      expect(confirmedEdgeBefore.provenance).toBe('human_confirmed');

      // A later run's adapter infers the *opposite* direction — contradicting the confirmed claim
      // — and, being fully `collected`, also no longer reports a->b itself.
      const now = new Date().toISOString();
      const opposite: DependencyObservation = {
        kind: 'dependency_observation',
        fromNaturalKey: 'contradiction-b',
        toNaturalKey: 'contradiction-a',
        edgeType: 'depends_on',
        layer: 'code',
        provenance: 'derived_from_code',
        observationCount: 3,
        firstObservedAt: now,
        lastObservedAt: now,
        windowSeconds: 3600,
      };
      const sources: DiscoverySourceRequest[] = [
        {
          requested: true,
          adapter: fakeAdapter('gitlab-contradiction', 'code', 'derived_from_code', async () => ({
            ...emptyFacts,
            componentCandidates: [
              {
                kind: 'component_candidate',
                naturalKey: 'contradiction-a',
                name: 'contradiction-a',
                componentType: 'service',
                characteristics: [],
                sourcePaths: [],
                adapterKey: 'gitlab-contradiction',
                adapterVersion: '1.0.0',
              },
              {
                kind: 'component_candidate',
                naturalKey: 'contradiction-b',
                name: 'contradiction-b',
                componentType: 'service',
                characteristics: [],
                sourcePaths: [],
                adapterKey: 'gitlab-contradiction',
                adapterVersion: '1.0.0',
              },
            ],
            dependencyObservations: [opposite],
          })),
        },
      ];

      const draft = await withCorrelation('corr-t029-rerun', () =>
        runDiscovery(discoveryRepo, CONTEXT, {
          trigger: 'manual',
          runnerId: 'runner-1',
          sources,
          perSourceTimeoutMs: 5000,
          itemCap: 1000,
        }),
      );
      expect(draft).not.toBeNull();

      // The confirmed edge stands, byte-identical — discovery never writes graph_edge directly.
      const confirmedEdgeAfter = await prisma.graphEdge.findUniqueOrThrow({
        where: { id: confirmedEdgeBefore.id },
      });
      expect(confirmedEdgeAfter).toEqual(confirmedEdgeBefore);

      // The contradiction surfaces as draft items for a human, not as a drift_finding (Phase 7
      // doesn't exist yet — see QUESTIONS.md "004 Phase 3 — two coordinator calls").
      const items = await prisma.draftItem.findMany({
        where: { tenantId: TENANT_ID, draftId: draft!.draftId },
      });
      const reversed = items.find(
        (i) =>
          i.op === 'add_edge' &&
          (i.proposed as { from: { naturalKey: string }; to: { naturalKey: string } }).from
            .naturalKey === 'contradiction-b',
      );
      expect(reversed).toBeDefined();
      expect(await prisma.driftFinding.count({ where: { tenantId: TENANT_ID } })).toBe(0);

      // The confirmed edge's only contributing adapter is `human` (the confirmation itself,
      // `edge_provenance.adapter_key`) — `human` never runs again as a discovery source, so
      // `markRemovedEdges`'s "every contributing adapter ran collected this run" rule can never
      // be satisfied for it, by construction. No `mark_removed` targets it: FR-012's "never
      // overwritten" holds even in the sense of never being proposed for removal, not only in
      // the sense of the row itself staying unwritten (both proven above and here).
      expect(
        items.some((i) => i.op === 'mark_removed' && i.targetEdgeId === confirmedEdgeBefore.id),
      ).toBe(false);
    });
  });
});
