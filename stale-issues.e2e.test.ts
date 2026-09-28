import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  ConcurrentModificationError,
  markStaleIssues,
  PrismaIssueRepository,
  STALE_WINDOW_MS,
  type NewIssue,
} from '@healer/domain-issues';
import { TenantContext, newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * The staleness sweep against a real database (001 T051, FR-017, R-11, quickstart 19): an issue
 * nothing has happened to is marked and surfaced, and **never** resolved. The "no progress" half is
 * what needs a database to prove — an issue being actively worked on has an old `last_seen_at` and
 * must still not be swept.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000b1';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000b2';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);

const NOW = new Date('2026-06-01T00:00:00Z');
const LONG_AGO = new Date(NOW.getTime() - STALE_WINDOW_MS - 24 * 60 * 60 * 1000);
const RECENTLY = new Date(NOW.getTime() - 60 * 60 * 1000);

describe('staleness sweep (001 T051, FR-017, R-11)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaIssueRepository;

  function newIssue(overrides: Partial<NewIssue> = {}): NewIssue {
    return {
      id: randomUUID(),
      kind: 'production_incident',
      environment: 'prod',
      severity: 'high',
      fingerprint: `fp-${randomUUID()}`,
      rulesetVersion: 1,
      firstSeenAt: LONG_AGO,
      lastSeenAt: LONG_AGO,
      ...overrides,
    };
  }

  /**
   * Progress is the system's clock (`received_at`, `created_at`), which no repository method lets
   * a caller set — so the test ages rows the way retention does, through the privileged-write
   * bypass `issue_event`'s append-only trigger allows (R-03). `eventType` ages only that kind of
   * event, leaving the issue's other history as it was.
   */
  async function ageIssue(id: string, when: Date, eventType?: string): Promise<void> {
    // 456 microseconds on top: `received_at` is microsecond-precise in production, and the
    // sweep's progress check has to survive `lastProgressAt` having been truncated to
    // milliseconds by a JS `Date`. Whole-millisecond test data would hide that entirely.
    const events = `update "issue"."issue_event"
      set received_at = '${when.toISOString()}'::timestamptz + interval '456 microseconds'
      where issue_id = '${id}' ${eventType === undefined ? '' : `and type = '${eventType}'`};`;
    const issue =
      eventType === undefined
        ? `update "issue"."issue" set created_at = '${when.toISOString()}' where id = '${id}';`
        : '';
    await query(pg, `begin; set local healer.privileged_write = 'on'; ${events} ${issue} commit;`);
  }

  /** An issue nothing has happened to since `LONG_AGO`. */
  async function idleIssue(overrides: Partial<NewIssue> = {}): Promise<string> {
    const input = newIssue(overrides);
    await repo.create(scope(CONTEXT, input));
    await ageIssue(input.id, LONG_AGO);
    return input.id;
  }

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
    repo = new PrismaIssueRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('marks an idle issue stale and records when it last made progress', () =>
    withCorrelation(newCorrelationId(), async () => {
      const id = await idleIssue();

      const { marked } = await markStaleIssues(repo, CONTEXT, NOW);

      expect(marked.map((i) => i.id)).toContain(id);
      const row = await repo.findById(scope(CONTEXT, { id }));
      expect(row).toMatchObject({ state: 'stale', staleAt: NOW });
      const payload = await query(
        pg,
        `select payload->>'lastProgressAt' from "events"."outbox"
         where name = 'IssueStale' and subject_id = '${id}'`,
      );
      expect(payload).toBe(LONG_AGO.toISOString());
    }));

  it('leaves an issue alone while it is being worked on, however old its last signal is', () =>
    withCorrelation(newCorrelationId(), async () => {
      const id = await idleIssue();
      await repo.transition(scope(CONTEXT, { id }), 'investigating', 'agent', 'investigator');
      await ageIssue(id, RECENTLY, 'state_changed');

      const { marked } = await markStaleIssues(repo, CONTEXT, NOW);

      expect(marked.map((i) => i.id)).not.toContain(id);
      expect(await repo.findById(scope(CONTEXT, { id }))).toMatchObject({
        state: 'investigating',
        staleAt: null,
      });
    }));

  it('refuses to mark an issue that received a signal after the sweep read it', () =>
    withCorrelation(newCorrelationId(), async () => {
      const id = await idleIssue();
      const idleBefore = new Date(NOW.getTime() - STALE_WINDOW_MS);
      const [candidate] = (await repo.findStaleCandidates(scope(CONTEXT, { idleBefore }))).filter(
        (c) => c.id === id,
      );
      expect(candidate).toBeDefined();

      // The signal lands after the read, before the write.
      await repo.recordOccurrence(scope(CONTEXT, { id }), NOW);

      await expect(
        repo.markStale(scope(CONTEXT, { id, at: NOW, lastProgressAt: candidate!.lastProgressAt })),
      ).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect(await repo.findById(scope(CONTEXT, { id }))).toMatchObject({
        state: 'detected',
        staleAt: null,
      });
    }));

  it('waits for a signal that is mid-commit on the same issue, rather than marking it stale over the top', () =>
    withCorrelation(newCorrelationId(), async () => {
      const id = await idleIssue();
      const idleBefore = new Date(NOW.getTime() - STALE_WINDOW_MS);
      const [candidate] = (await repo.findStaleCandidates(scope(CONTEXT, { idleBefore }))).filter(
        (c) => c.id === id,
      );
      expect(candidate).toBeDefined();

      // What `recordOccurrence` does — lock the row with an UPDATE, then write the event — held
      // open. The sweep's progress check cannot see this uncommitted event; only waiting on the
      // row lock and re-reading afterwards can.
      let commit!: () => void;
      const mayCommit = new Promise<void>((resolve) => (commit = resolve));
      let inFlight!: () => void;
      const signalInFlight = new Promise<void>((resolve) => (inFlight = resolve));
      const signal = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "issue"."issue" SET occurrence_count = occurrence_count + 1
          WHERE id = ${id}::uuid AND tenant_id = ${TENANT_ID}::uuid`;
        await tx.issueEvent.create({
          data: {
            id: randomUUID(),
            tenantId: TENANT_ID,
            issueId: id,
            type: 'signal_received',
            cause: 'ingestion',
            actorRef: 'ingestion',
            payload: {},
            observedAt: NOW,
          },
        });
        inFlight();
        await mayCommit;
      });
      await signalInFlight;

      const marking = repo
        .markStale(scope(CONTEXT, { id, at: NOW, lastProgressAt: candidate!.lastProgressAt }))
        .then(
          () => 'marked' as const,
          (error: unknown) => error,
        );
      await new Promise((resolve) => setTimeout(resolve, 500));
      commit();
      await signal;

      expect(await marking).toBeInstanceOf(ConcurrentModificationError);
      expect(await repo.findById(scope(CONTEXT, { id }))).toMatchObject({
        state: 'detected',
        staleAt: null,
      });
    }));

  it('never resolves anything, and sweeping twice marks nothing new (R-11)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const id = await idleIssue();
      await markStaleIssues(repo, CONTEXT, NOW);

      const { marked: second } = await markStaleIssues(repo, CONTEXT, NOW);

      expect(second.map((i) => i.id)).not.toContain(id);
      // This issue's own state — a query over the whole tenant depends on what other tests left.
      expect(await repo.findById(scope(CONTEXT, { id }))).toMatchObject({ state: 'stale' });
      const names = await query(
        pg,
        `select string_agg(name, ',' order by occurred_at) from "events"."outbox"
         where subject_id = '${id}'`,
      );
      expect(names).toBe('IssueDetected,IssueStale');
    }));

  it('leaves a resolved issue out of the sweep — "stopped happening" is not "was fixed"', () =>
    withCorrelation(newCorrelationId(), async () => {
      const id = await idleIssue();
      await repo.transition(scope(CONTEXT, { id }), 'resolved', 'human', 'operator');
      await ageIssue(id, LONG_AGO);

      const { marked } = await markStaleIssues(repo, CONTEXT, NOW);

      expect(marked.map((i) => i.id)).not.toContain(id);
      expect(await repo.findById(scope(CONTEXT, { id }))).toMatchObject({ state: 'resolved' });
    }));

  it('never sweeps another tenant’s issues — the query itself is tenant-scoped', () =>
    withCorrelation(newCorrelationId(), async () => {
      const id = await idleIssue();

      const { marked } = await markStaleIssues(repo, OTHER_CONTEXT, NOW);

      expect(marked).toEqual([]);
      expect(await repo.findById(scope(CONTEXT, { id }))).toMatchObject({ state: 'detected' });
    }));
});
