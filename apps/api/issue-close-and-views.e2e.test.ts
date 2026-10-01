import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BullmqSignalQueue,
  PrismaAuditRepository,
  PrismaIngestionDeliveryRepository,
  PrismaIssueRepository,
  PrismaTimelineRepository,
} from '@healer/domain-issues';
import {
  PrismaEvidenceGraphRepository,
  PrismaEvidenceLinkRepository,
  PrismaEvidenceRepository,
  type NewEvidence,
} from '@healer/domain-evidence';
import {
  PrismaAutonomyGrantRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
} from '@healer/domain-policy';
import { TenantContext, newCorrelationId, scope, withCorrelation, withStep } from '@healer/shared';
import { PrismaClient } from '@healer/prisma-client';
import { assertTenantIsolated } from '../../test/tenant-isolation.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { PrismaRunnerRegistrationRepository } from './src/runners/infrastructure/prisma-runner-registration-repository.js';
import { configureApiPrefix, createApiModule } from './src/main.js';

/**
 * `POST /issues/{id}/close` (001 T057, FR-021, C-09, quickstart 27) and the timeline and
 * evidence-graph routes (001 T048, FR-013, SC-004, SC-005, quickstart 16, 22) over real HTTP
 * against a real Postgres. The signal queue is pointed at a closed port: nothing here ingests.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000a1';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

describe('close, timeline and evidence graph (001 T057/T048)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let issues: PrismaIssueRepository;
  let evidence: PrismaEvidenceRepository;
  let audit: PrismaAuditRepository;

  const createIssue = (tenantId = TENANT_ID) =>
    withCorrelation(newCorrelationId(), async () => {
      const created = await issues.create(
        scope(TenantContext.forTrustedInternalUse(tenantId), {
          id: randomUUID(),
          kind: 'production_incident',
          environment: 'prod',
          severity: 'high',
          fingerprint: `fp-${randomUUID()}`,
          rulesetVersion: 1,
          firstSeenAt: new Date('2026-01-01T00:00:00Z'),
          lastSeenAt: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      return created.id;
    });

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    issues = new PrismaIssueRepository(prisma);
    evidence = new PrismaEvidenceRepository(prisma);
    audit = new PrismaAuditRepository(prisma);

    const ApiModule = createApiModule(
      { service: 'healer-api', version: 'test', build: 'test', runnerProtocolVersion: 1 },
      new BullmqSignalQueue({ url: 'redis://127.0.0.1:6399' }),
      new PrismaIngestionDeliveryRepository(prisma),
      issues,
      evidence,
      audit,
      new PrismaTimelineRepository(prisma),
      new PrismaEvidenceGraphRepository(prisma),
      new PrismaPolicyRulesetRepository(prisma),
      new PrismaPolicyDecisionRepository(prisma),
      new PrismaPolicyActionRepository(prisma),
      new PrismaRunnerRegistrationRepository(prisma),
      new PrismaAutonomyGrantRepository(prisma),
    );
    app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
    configureApiPrefix(app);
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  describe('POST /issues/{issueId}/close (001 T057, FR-021, C-09, quickstart 27)', () => {
    const CLOSE_HEADERS = () => ({ 'X-Actor-Id': 'pavlo', 'Idempotency-Key': randomUUID() });

    const close = (
      issueId: string,
      {
        tenantId = TENANT_ID,
        headers = CLOSE_HEADERS(),
        body = { reason: 'fixed it by hand' } as unknown,
      } = {},
    ) =>
      request(app.getHttpServer())
        .post(`/api/v1/issues/${issueId}/close`)
        .set({ 'X-Tenant-Id': tenantId, ...headers })
        .send(body as object);

    const outbox = (issueId: string, name: string) =>
      prisma.outbox.findMany({ where: { tenantId: TENANT_ID, subjectId: issueId, name } });

    const REPLAY = 'idempotent-replay';

    const auditFor = async (issueId: string) =>
      (
        await request(app.getHttpServer())
          .get(`/api/v1/issues/${issueId}/audit`)
          .set('X-Tenant-Id', TENANT_ID)
          .expect(200)
      ).body.items as { actorType: string; actorRef: string; action: string; reason: string }[];

    it('resolves the issue as self_resolved, with no verification evidence, recorded as a human event and audited', async () => {
      const issueId = await createIssue();
      const response = await close(issueId).expect(200);

      expect(response.body).toMatchObject({ id: issueId, state: 'resolved' });
      expect(response.headers[REPLAY]).toBeUndefined(); // a real close is not a replay
      const published = await outbox(issueId, 'IssueResolved');
      expect(published.map((row) => row.payload)).toEqual([
        { resolutionKind: 'self_resolved', verificationEvidenceIds: [] },
      ]);
      const events = await prisma.issueEvent.findMany({
        where: { tenantId: TENANT_ID, issueId, type: 'state_changed', toState: 'resolved' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        cause: 'human',
        actorRef: 'pavlo',
        payload: { reason: 'fixed it by hand' },
      });
      // FR-012: the human action is indexed by the audit trail like every other actor's.
      expect(await auditFor(issueId)).toMatchObject([
        {
          actorType: 'human',
          actorRef: 'pavlo',
          action: 'issue.close',
          reason: 'fixed it by hand',
        },
      ]);
    });

    it('a repeated close — same key, a fresh one, another actor and reason — is a 200 the client can tell is a replay, and the original is kept', async () => {
      const issueId = await createIssue();
      const headers = CLOSE_HEADERS();
      await close(issueId, { headers }).expect(200);
      const again = await close(issueId, { headers }).expect(200);
      const other = await close(issueId, {
        headers: { 'X-Actor-Id': 'someone-else', 'Idempotency-Key': randomUUID() },
        body: { reason: 'a different reason' },
      }).expect(200);

      expect(again.body).toMatchObject({ state: 'resolved' });
      expect(again.headers[REPLAY]).toBe('true');
      expect(other.headers[REPLAY]).toBe('true');
      expect(await outbox(issueId, 'IssueResolved')).toHaveLength(1);
      expect(await outbox(issueId, 'IssueStateChanged')).toHaveLength(1);
      // Nothing about the second closer was recorded anywhere; the first stands.
      const events = await prisma.issueEvent.findMany({
        where: { tenantId: TENANT_ID, issueId, type: 'state_changed' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorRef: 'pavlo',
        payload: { reason: 'fixed it by hand' },
      });
      expect(await auditFor(issueId)).toMatchObject([{ actorRef: 'pavlo' }]);
    });

    // Not a proof that the lost-race branch was entered (that needs a held-open transaction:
    // issue-resolved.e2e.test.ts) — only that however the three interleave, exactly one closes.
    it('three closes at once resolve it once: one real close, the others replays, all 200', async () => {
      const issueId = await createIssue();
      const responses = await Promise.all([close(issueId), close(issueId), close(issueId)]);

      expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(responses.filter((r) => r.headers[REPLAY] === undefined)).toHaveLength(1);
      expect(await outbox(issueId, 'IssueResolved')).toHaveLength(1);
      expect(await auditFor(issueId)).toHaveLength(1);
    });

    it.each(['merged', 'removed'] as const)(
      'a %s issue cannot be closed — 409, and nothing is published or audited',
      async (state) => {
        const issueId = await createIssue();
        await withCorrelation(newCorrelationId(), async () => {
          if (state === 'merged') {
            // Through the merge operation: a plain transition to `merged` is refused (001 T049).
            const target = await createIssue();
            await issues.merge(
              scope(CONTEXT, { id: issueId, intoId: target }),
              'pavlo',
              'duplicate of the target',
            );
          } else {
            await issues.transition(scope(CONTEXT, { id: issueId }), state, 'human', 'pavlo');
          }
        });
        await close(issueId).expect(409);
        expect(await outbox(issueId, 'IssueResolved')).toHaveLength(0);
        expect(await auditFor(issueId)).toHaveLength(0);
      },
    );

    it('accepts the largest actor (128) and reason (1000) and refuses one more of either', async () => {
      const ok = await createIssue();
      await close(ok, {
        headers: { 'X-Actor-Id': 'a'.repeat(128), 'Idempotency-Key': randomUUID() },
        body: { reason: 'r'.repeat(1000) },
      }).expect(200);
      const stored = await prisma.issueEvent.findFirst({
        where: { tenantId: TENANT_ID, issueId: ok, type: 'state_changed' },
      });
      expect(stored?.actorRef).toBe('a'.repeat(128));
      expect((stored?.payload as { reason: string }).reason).toHaveLength(1000);

      const refused = await createIssue();
      await close(refused, {
        headers: { 'X-Actor-Id': 'a'.repeat(129), 'Idempotency-Key': randomUUID() },
      }).expect(400);
      await close(refused, { body: { reason: 'r'.repeat(1001) } }).expect(400);
      expect((await issues.findById(scope(CONTEXT, { id: refused })))?.state).toBe('detected');
    });

    it('rejects a request that does not say who, why or under which key — 400, issue untouched', async () => {
      const issueId = await createIssue();
      const valid = CLOSE_HEADERS();
      const attempts: [string, Parameters<typeof close>[1]][] = [
        ['no Idempotency-Key', { headers: { 'X-Actor-Id': 'pavlo' } }],
        [
          'Idempotency-Key not a uuid',
          { headers: { 'X-Actor-Id': 'pavlo', 'Idempotency-Key': 'x' } },
        ],
        ['no X-Actor-Id', { headers: { 'Idempotency-Key': valid['Idempotency-Key'] } }],
        ['blank X-Actor-Id', { headers: { ...valid, 'X-Actor-Id': '   ' } }],
        ['no reason', { body: {} }],
        ['blank reason', { body: { reason: '   ' } }],
        ['reason not a string', { body: { reason: 42 } }],
        ['reason with a NUL', { body: { reason: 'a\u0000b' } }],
      ];
      for (const [label, options] of attempts) {
        const response = await close(issueId, options);
        expect({ label, status: response.status }).toEqual({ label, status: 400 });
      }
      expect((await issues.findById(scope(CONTEXT, { id: issueId })))?.state).toBe('detected');
      expect(await outbox(issueId, 'IssueResolved')).toHaveLength(0);
      expect(await auditFor(issueId)).toHaveLength(0);
    });

    it('404s for an issue id that does not exist at all', async () => {
      await close(randomUUID()).expect(404);
    });

    it("404s another tenant's issue — never 403 — and leaves it open", async () => {
      const issueId = await createIssue();
      const other = randomUUID();
      await close(issueId, { tenantId: other }).expect(404);
      expect((await issues.findById(scope(CONTEXT, { id: issueId })))?.state).toBe('detected');
      expect(await outbox(issueId, 'IssueResolved')).toHaveLength(0);
    });

    it('is tenant-isolated (gate-isolation)', () =>
      assertTenantIsolated(app, 'POST', '/api/v1/issues/:issueId/close', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderTenant: createIssue,
        requestHeaders: CLOSE_HEADERS(),
        body: { reason: 'isolation check' },
      }));
  });

  describe('GET /issues/{issueId}/timeline and /evidence-graph (001 T048, FR-013, SC-004)', () => {
    const get = (path: string, tenantId = TENANT_ID) =>
      request(app.getHttpServer()).get(`/api/v1${path}`).set('X-Tenant-Id', tenantId);

    it('404s an issue id that does not exist, on both routes', async () => {
      await get(`/issues/${randomUUID()}/timeline`).expect(404);
      await get(`/issues/${randomUUID()}/evidence-graph`).expect(404);
    });

    it("404s another tenant's issue on both routes rather than returning an empty view", async () => {
      const issueId = await createIssue();
      await get(`/issues/${issueId}/timeline`, randomUUID()).expect(404);
      await get(`/issues/${issueId}/evidence-graph`, randomUUID()).expect(404);
    });

    it('timeline is tenant-isolated (gate-isolation)', () =>
      assertTenantIsolated(app, 'GET', '/api/v1/issues/:issueId/timeline', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderTenant: createIssue,
      }));

    it('evidence graph is tenant-isolated (gate-isolation)', () =>
      assertTenantIsolated(app, 'GET', '/api/v1/issues/:issueId/evidence-graph', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderTenant: createIssue,
      }));

    it('a fresh issue has a timeline of its own creation and an empty graph', async () => {
      const issueId = await createIssue();
      const timeline = await get(`/issues/${issueId}/timeline`).expect(200);
      expect(timeline.body.items).toHaveLength(1);
      expect(timeline.body.items[0]).toMatchObject({
        source: 'issue_event',
        type: 'signal_received',
      });
      const graph = await get(`/issues/${issueId}/evidence-graph`).expect(200);
      expect(graph.body).toEqual({ nodes: [], edges: [] });
    });

    /** One issue's worth of history: cited, uncited and detached evidence, two links to two
     *  conclusions, two state changes, a workflow run with a machine step, and an audit entry
     *  citing the cited and the detached evidence. */
    async function seedHistory(issueId: string) {
      const newEvidence = (over: Partial<NewEvidence>): NewEvidence => ({
        id: randomUUID(),
        issueId,
        type: 'error_signature',
        sourceSystem: 'loki',
        sourceRef: 'ref',
        sourceLabel: 'from logs',
        excerpt: 'an excerpt',
        excerptTruncated: false,
        payload: {},
        producedByStep: 'collector',
        observedAt: new Date('2026-01-01T00:00:10Z'),
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        ...over,
      });
      const cited = newEvidence({ observedAt: new Date('2026-01-01T00:00:10Z') });
      const uncited = newEvidence({
        type: 'trace_shape',
        observedAt: new Date('2026-01-01T00:00:20Z'),
      });
      const detached = newEvidence({
        type: 'test_result',
        observedAt: new Date('2026-01-01T00:00:30Z'),
      });
      const [conclusionA, conclusionB] = [randomUUID(), randomUUID()];

      await withCorrelation(newCorrelationId(), async () => {
        for (const e of [cited, uncited, detached]) await evidence.record(scope(CONTEXT, e));
        await evidence.detach(scope(CONTEXT, { id: detached.id }));
        const links = new PrismaEvidenceLinkRepository(prisma);
        await withStep('diagnose', async () => {
          await links.write(
            scope(CONTEXT, {
              id: randomUUID(),
              evidenceId: cited.id,
              conclusionType: 'diagnosis',
              conclusionId: conclusionA,
              relation: 'supports',
            }),
          );
          await links.write(
            scope(CONTEXT, {
              id: randomUUID(),
              evidenceId: detached.id,
              conclusionType: 'hypothesis',
              conclusionId: conclusionB,
              relation: 'contextualises',
            }),
          );
        });
        const at = scope(CONTEXT, { id: issueId });
        await issues.transition(at, 'investigating', 'agent', 'triager');
        await issues.transition(at, 'diagnosed', 'agent', 'diagnoser');
      });
      const runId = randomUUID();
      await prisma.workflowRun.create({
        data: {
          id: runId,
          tenantId: TENANT_ID,
          issueId,
          definitionKey: 'investigation',
          definitionVersion: 1,
          state: 'classifying',
          correlationId: randomUUID(),
        },
      });
      const transitionId = randomUUID();
      await prisma.workflowTransition.create({
        data: {
          id: transitionId,
          tenantId: TENANT_ID,
          runId,
          fromState: 'queued',
          toState: 'classifying',
          cause: 'job',
          occurredAt: new Date('2026-01-01T00:00:05Z'),
        },
      });
      const auditEntry = await audit.record(
        scope(CONTEXT, {
          id: randomUUID(),
          actorType: 'human',
          actorRef: 'pavlo',
          action: 'issue.review',
          targetType: 'issue',
          targetId: issueId,
          reason: 'reviewed the diagnosis',
          evidenceIds: [cited.id, detached.id],
          outcome: 'ok',
        }),
      );
      return { cited, uncited, detached, conclusionA, conclusionB, transitionId, auditEntry };
    }

    /**
     * Quickstart 16 — "same facts, different arrangements" (SC-005). The three views are queries
     * over the same records, so the ground truth is what was *written*, read straight from the
     * tables with an explicit `issue_id`, never from a view: a view that dropped a record,
     * invented one, or pointed a citation at the wrong evidence fails here, and so does every
     * view dropping the same record. Two other issues in the same tenant carry their own
     * evidence, links, machine steps and audit entries, so a view that lost its `issue_id`
     * filter fails as well.
     *
     * "Same facts" means, precisely, for one issue:
     *  1. evidence: the evidence ids on the timeline == the evidence nodes of the graph == the
     *     evidence rows written == `GET /evidence` — detached and uncited evidence included;
     *  2. domain facts: the timeline's `issue_event` and `workflow_transition` entries are exactly
     *     the rows in those tables for this issue — nothing dropped, nothing invented;
     *  3. citations: the graph's edges are exactly the `(evidence, conclusion, relation)` tuples
     *     of this issue's `evidence_link` rows, and both ends of every edge are graph nodes;
     *  4. audit: the entry targets this issue, and its evidence ids are exactly the two it cited,
     *     each present on the timeline and in the graph.
     */
    it('timeline, evidence graph and audit for one issue contain the same facts (quickstart 16)', async () => {
      const issueId = await createIssue();
      const mine = await seedHistory(issueId);
      const { cited, uncited, detached, conclusionA, conclusionB, transitionId, auditEntry } = mine;
      for (const noiseIssue of [await createIssue(), await createIssue()]) {
        await seedHistory(noiseIssue);
      }

      const rows = async (sql: string): Promise<string[]> =>
        (await prisma.$queryRawUnsafe<{ id: string }[]>(sql)).map((r) => r.id).sort();
      const truth = {
        evidence: await rows(
          `select id::text from "evidence"."evidence" where issue_id = '${issueId}'::uuid`,
        ),
        issueEvents: await rows(
          `select id::text from "issue"."issue_event" where issue_id = '${issueId}'::uuid`,
        ),
        transitions: await rows(
          `select t.id::text from "workflow"."workflow_transition" t
           join "workflow"."workflow_run" r on r.id = t.run_id where r.issue_id = '${issueId}'::uuid`,
        ),
        links: await rows(
          `select e.id::text || '|' || l.conclusion_id::text || '|' || l.relation::text as id
           from "evidence"."evidence_link" l
           join "evidence"."evidence" e on e.id = l.evidence_id where e.issue_id = '${issueId}'::uuid`,
        ),
      };
      expect(truth.evidence).toEqual([cited.id, uncited.id, detached.id].sort());
      expect(truth.issueEvents.length).toBeGreaterThanOrEqual(3);
      expect(truth.transitions).toEqual([transitionId]);
      expect(truth.links).toEqual(
        [
          `${cited.id}|${conclusionA}|supports`,
          `${detached.id}|${conclusionB}|contextualises`,
        ].sort(),
      );
      // The noise is real: this tenant holds far more than this issue's rows.
      const tenantRows = await rows(
        `select count(*)::text as id from "evidence"."evidence" where tenant_id = '${TENANT_ID}'::uuid`,
      );
      expect(Number(tenantRows[0])).toBeGreaterThan(truth.evidence.length);

      const timeline = (await get(`/issues/${issueId}/timeline`).expect(200)).body.items as {
        source: string;
        id: string;
        evidenceIds: string[];
      }[];
      const graph = (await get(`/issues/${issueId}/evidence-graph`).expect(200)).body as {
        nodes: { kind: string; id: string; refState?: string }[];
        edges: { evidenceId: string; conclusionId: string; relation: string }[];
      };
      const auditItems = (await get(`/issues/${issueId}/audit`).expect(200)).body.items as {
        id: string;
        targetId: string;
        evidenceIds: string[];
      }[];
      const evidenceList = (await get(`/issues/${issueId}/evidence`).expect(200)).body.items as {
        id: string;
      }[];
      const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

      // 1. evidence
      const timelineEvidence = timeline.filter((e) => e.source === 'evidence');
      const graphEvidence = graph.nodes.filter((n) => n.kind === 'evidence');
      expect(ids(timelineEvidence)).toEqual(truth.evidence);
      expect(ids(graphEvidence)).toEqual(truth.evidence);
      expect(ids(evidenceList)).toEqual(truth.evidence);
      expect(timelineEvidence.flatMap((e) => e.evidenceIds).sort()).toEqual(truth.evidence);
      expect(graphEvidence.find((n) => n.id === detached.id)?.refState).toBe('detached');

      // 2. domain facts
      expect(ids(timeline.filter((e) => e.source === 'issue_event'))).toEqual(truth.issueEvents);
      expect(ids(timeline.filter((e) => e.source === 'workflow_transition'))).toEqual(
        truth.transitions,
      );
      expect(timeline).toHaveLength(
        truth.evidence.length + truth.issueEvents.length + truth.transitions.length,
      );

      // 3. citations: the tuples, not their number
      expect(
        graph.edges.map((e) => `${e.evidenceId}|${e.conclusionId}|${e.relation}`).sort(),
      ).toEqual(truth.links);
      const nodeIds = new Set(graph.nodes.map((n) => n.id));
      for (const edge of graph.edges) {
        expect(nodeIds.has(edge.evidenceId)).toBe(true);
        expect(nodeIds.has(edge.conclusionId)).toBe(true);
      }
      expect(
        graph.nodes
          .filter((n) => n.kind === 'conclusion')
          .map((n) => n.id)
          .sort(),
      ).toEqual([conclusionA, conclusionB].sort());

      // 4. audit
      expect(auditItems).toHaveLength(1);
      expect(auditItems[0]!.id).toBe(auditEntry.id);
      expect(auditItems[0]!.targetId).toBe(issueId);
      expect([...auditItems[0]!.evidenceIds].sort()).toEqual([cited.id, detached.id].sort());
      for (const evidenceId of auditItems[0]!.evidenceIds) {
        expect(timelineEvidence.some((e) => e.id === evidenceId)).toBe(true);
        expect(nodeIds.has(evidenceId)).toBe(true);
      }
    });

    // What this proves: two separate requests over the same stored records return the same bytes
    // (nothing time- or randomness-dependent in the render path) — for the timeline and for the
    // graph. What it does not prove: that the order is the *right* order (`timeline.e2e.test.ts`
    // pins observed-over-received and the tie-breakers), nor stability while writes are landing.
    it('renders byte-identical timeline and graph across separate requests (SC-005)', async () => {
      const issueId = await createIssue();
      await seedHistory(issueId);

      const timelineFirst = (await get(`/issues/${issueId}/timeline`).expect(200)).text;
      const graphFirst = (await get(`/issues/${issueId}/evidence-graph`).expect(200)).text;
      expect((await get(`/issues/${issueId}/timeline`).expect(200)).text).toBe(timelineFirst);
      expect((await get(`/issues/${issueId}/evidence-graph`).expect(200)).text).toBe(graphFirst);
      expect(JSON.parse(timelineFirst).items.length).toBeGreaterThan(5); // not trivially equal
    });
  });
});
