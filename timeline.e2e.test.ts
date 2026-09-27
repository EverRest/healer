import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { PrismaIssueRepository, PrismaTimelineRepository } from '@healer/domain-issues';
import { TenantContext, newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `GetTimeline` (001 T045/T046, FR-013, SC-005, R-07, C-14): one ordered sequence over three
 * tables with different grains — `issue_event` (domain facts), 012's `workflow_transition`
 * (machine steps) and `evidence` — computed by a union query, with no model anywhere in the path.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000f1';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000f2';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);

describe('PrismaTimelineRepository (001 T045/T046, FR-013)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let issues: PrismaIssueRepository;
  let timeline: PrismaTimelineRepository;

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
    await prisma.$connect();
    issues = new PrismaIssueRepository(prisma);
    timeline = new PrismaTimelineRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  async function newIssue(): Promise<string> {
    const id = randomUUID();
    await issues.create(
      scope(CONTEXT, {
        id,
        kind: 'production_incident',
        environment: 'prod',
        severity: 'high',
        fingerprint: `fp-${randomUUID()}`,
        rulesetVersion: 1,
        firstSeenAt: new Date('2026-01-01T00:00:00Z'),
        lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    return id;
  }

  async function addEvidence(issueId: string, observedAt: Date): Promise<string> {
    const id = randomUUID();
    await prisma.evidence.create({
      data: {
        id,
        tenantId: TENANT_ID,
        issueId,
        type: 'error_signature',
        sourceSystem: 'loki',
        sourceRef: 'q1',
        sourceLabel: 'from logs',
        payload: {},
        producedByStep: 'investigate',
        observedAt,
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      },
    });
    return id;
  }

  async function addTransition(issueId: string, occurredAt: Date): Promise<string> {
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
    const id = randomUUID();
    await prisma.workflowTransition.create({
      data: {
        id,
        tenantId: TENANT_ID,
        runId,
        fromState: 'queued',
        toState: 'classifying',
        cause: 'job',
        occurredAt,
      },
    });
    return id;
  }

  it('unions domain facts, machine steps and evidence into one ordered sequence', () =>
    withCorrelation(newCorrelationId(), async () => {
      const issueId = await newIssue();
      await addTransition(issueId, new Date('2026-01-01T00:00:10Z'));
      await addEvidence(issueId, new Date('2026-01-01T00:00:20Z'));
      await issues.transition(
        scope(CONTEXT, { id: issueId }),
        'investigating',
        'system',
        'triager',
      );

      const entries = await timeline.forIssue(scope(CONTEXT, { issueId }));

      expect(entries.map((e) => e.source).sort()).toEqual([
        'evidence',
        'issue_event',
        'issue_event',
        'workflow_transition',
      ]);
      const times = entries.map((e) => e.at.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }));

  it('orders by observed time, not by the order rows were received (R-10)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const issueId = await newIssue();
      const late = await addEvidence(issueId, new Date('2026-06-01T00:00:00Z'));
      const early = await addEvidence(issueId, new Date('2026-05-01T00:00:00Z'));

      const ids = (await timeline.forIssue(scope(CONTEXT, { issueId })))
        .filter((e) => e.source === 'evidence')
        .map((e) => e.id);

      expect(ids).toEqual([early, late]);
    }));

  it('renders byte-identical output twice, including entries that share a timestamp (SC-005)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const issueId = await newIssue();
      const sameInstant = new Date('2026-03-01T00:00:00Z');
      await addEvidence(issueId, sameInstant);
      await addEvidence(issueId, sameInstant);
      await addTransition(issueId, sameInstant);

      const first = JSON.stringify(await timeline.forIssue(scope(CONTEXT, { issueId })));
      const second = JSON.stringify(await timeline.forIssue(scope(CONTEXT, { issueId })));

      expect(second).toBe(first);
    }));

  it('has a (tenant_id, issue_id) index on workflow_run for the timeline join (plan: < 200 ms p95)', async () => {
    const indexes = await query(
      pg,
      `select indexdef from pg_indexes
       where schemaname = 'workflow' and tablename = 'workflow_run'
         and indexdef like '%(tenant_id, issue_id)%'`,
    );

    expect(indexes).toContain('(tenant_id, issue_id)');
  });

  it('never returns another tenant’s entries — the query itself is tenant-scoped', () =>
    withCorrelation(newCorrelationId(), async () => {
      const issueId = await newIssue();
      await addEvidence(issueId, new Date('2026-01-01T00:00:20Z'));

      expect(await timeline.forIssue(scope(OTHER_CONTEXT, { issueId }))).toEqual([]);
    }));
});
