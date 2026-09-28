import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@healer/prisma-client';
import {
  ConcurrentModificationError,
  DeletionIntegrityError,
  DeletionTimedOutError,
  ISSUE_ID_COLUMNS,
  IssueEventsInFlightError,
  IssueHasMergedChildrenError,
  IssueMergedIntoAnotherError,
  InvalidDeletionRequestError,
  deleteIssue,
  PrismaAuditRepository,
  PrismaIssueDeletionRepository,
  PrismaIssueRepository,
  PrismaTimelineRepository,
} from '@healer/domain-issues';
import {
  PrismaEvidenceGraphRepository,
  PrismaEvidenceLinkRepository,
  PrismaEvidenceRepository,
  PrismaEvidenceRetentionRepository,
} from '@healer/domain-evidence';
import {
  NotFoundError,
  TenantContext,
  newCorrelationId,
  scope,
  withCorrelation,
  withStep,
} from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * Tenant deletion (001 T053, FR-018, R-12, quickstart 23): the issue and everything derived from it
 * is gone, a tombstone with identifiers only remains, and nothing that is not the issue's was
 * touched. The risks are (1) something derived that survives — a table nobody remembered, (2) a
 * neighbour that does not — another issue's rows, another tenant's, (3) the append-only bypass
 * outliving its transaction, and (4) a race with whoever else writes to the issue.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));
const TOMBSTONE_MIGRATION = '20260929000000_deletion_tombstone_guarantees';

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000d1';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000d2';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);
const WHEN = new Date('2026-01-01T00:00:00Z');
const REASON = 'customer asked for erasure';

interface Seeded {
  readonly id: string;
  readonly evidenceIds: readonly [string, string];
  readonly runId: string;
  /** Strings that exist only in this issue's rows — none may appear in a tombstone. */
  readonly secrets: readonly string[];
}

describe('tenant deletion of an issue (001 T053)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaIssueRepository;
  let deletion: PrismaIssueDeletionRepository;
  let links: PrismaEvidenceLinkRepository;
  let promptVersionId: string;
  const extraClients: PrismaClient[] = [];

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`,
    );
    promptVersionId = randomUUID();
    await query(
      pg,
      `insert into "prompt"."prompt_version" (id, key, digest, body, published_by)
       values ('${promptVersionId}', 'investigate', 'd1', 'body', 'test')`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    repo = new PrismaIssueRepository(prisma);
    deletion = new PrismaIssueDeletionRepository(prisma);
    links = new PrismaEvidenceLinkRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(extraClients.map((client) => client.$disconnect()));
    await prisma?.$disconnect();
    await pg?.stop();
  });

  const inScope = <T>(fn: () => Promise<T>) => withCorrelation(newCorrelationId(), fn);
  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ value }) as { value: T; error?: undefined },
      (error: unknown) => ({ error }) as { value?: undefined; error: unknown },
    );
  const del = (id: string, context = CONTEXT, requestedBy = 'pavlo', reason = REASON) =>
    deletion.deleteIssue(scope(context, { id }), requestedBy, reason);

  /**
   * One issue with a row in every table a deletion has to reach: events (create, a transition, an
   * occurrence), two evidence records one of which a conclusion cites, audit entries about the issue
   * and about its evidence, a machine run with a step and a callback, an agent run, and the outbox
   * rows all of that published.
   */
  async function seed(context: TenantContext = CONTEXT): Promise<Seeded> {
    const tenantId = context.tenantId;
    const id = randomUUID();
    const componentId = randomUUID();
    const secrets = [
      `FINGERPRINT-${id}`,
      `EXCERPT-${id}`,
      `SOURCEREF-${id}`,
      `LABEL-${id}`,
      `PAYLOAD-${id}`,
      componentId,
    ];
    await repo.create(
      scope(context, {
        id,
        kind: 'production_incident',
        componentId,
        environment: 'prod',
        severity: 'high',
        fingerprint: secrets[0]!,
        rulesetVersion: 1,
        firstSeenAt: WHEN,
        lastSeenAt: WHEN,
      }),
    );
    await repo.transition(scope(context, { id }), 'investigating', 'agent', 'collector');
    await repo.recordOccurrence(scope(context, { id }), WHEN);
    const evidenceIds = [randomUUID(), randomUUID()] as const;
    for (const evidenceId of evidenceIds) {
      await prisma.evidence.create({
        data: {
          id: evidenceId,
          tenantId,
          issueId: id,
          type: 'error_signature',
          sourceSystem: 'loki',
          sourceRef: secrets[2]!,
          sourceLabel: secrets[3]!,
          excerpt: secrets[1]!,
          payload: { marker: secrets[4]! },
          producedByStep: 'collector',
          observedAt: WHEN,
          expiresAt: new Date('2027-01-01T00:00:00Z'),
        },
      });
    }
    await withStep('diagnose', () =>
      links.write(
        scope(context, {
          id: randomUUID(),
          evidenceId: evidenceIds[0],
          conclusionType: 'diagnosis',
          conclusionId: randomUUID(),
          relation: 'supports',
        }),
      ),
    );
    await prisma.auditEntry.createMany({
      data: [
        {
          id: randomUUID(),
          tenantId,
          actorType: 'human',
          actorRef: 'pavlo',
          action: 'issue.close',
          targetType: 'issue',
          targetId: id,
          reason: `closing ${secrets[1]}`,
          evidenceIds: [evidenceIds[0]],
          outcome: 'ok',
        },
        {
          id: randomUUID(),
          tenantId,
          actorType: 'system',
          actorRef: 'collector',
          action: 'evidence.note',
          targetType: 'evidence',
          targetId: evidenceIds[1],
          reason: 'noted',
          evidenceIds: [],
          outcome: 'ok',
        },
      ],
    });
    const runId = randomUUID();
    await query(
      pg,
      `insert into "workflow"."workflow_run"
         (id, tenant_id, issue_id, definition_key, definition_version, state, awaiting, correlation_id, updated_at)
       values ('${runId}', '${tenantId}', '${id}', 'investigate', 1, 'collecting', '{"marker":"${secrets[4]}"}', '${randomUUID()}', now());
       insert into "workflow"."workflow_transition"
         (id, tenant_id, run_id, from_state, to_state, cause)
       values ('${randomUUID()}', '${tenantId}', '${runId}', 'start', 'collecting', 'job');
       insert into "workflow"."workflow_callback"
         (id, run_id, tenant_id, kind, token_hash, expires_at)
       values ('${randomUUID()}', '${runId}', '${tenantId}', 'ci_result', 'h-${randomUUID()}', now());
       insert into "agent"."agent_run"
         (id, tenant_id, issue_id, correlation_id, agent_kind, prompt_version_id, model_id, provider,
          input_tokens, output_tokens, cost, tool_calls, outcome, started_at)
       values ('${randomUUID()}', '${tenantId}', '${id}', '${randomUUID()}', 'investigator',
               '${promptVersionId}', 'm', 'anthropic', 10, 20, 0.5, '[]', 'ok', now())`,
    );
    return { id, evidenceIds, runId, secrets };
  }

  const inScopeSeed = (context: TenantContext = CONTEXT) => inScope(() => seed(context));

  async function relate(
    issueId: string,
    otherIssueId: string,
    kind: 'related' | 'recurrence_of',
    tenantId = TENANT_ID,
  ) {
    await prisma.issueRelationship.create({
      data: { id: randomUUID(), tenantId, issueId, otherIssueId, kind, rule: 'test' },
    });
  }

  const count = async (table: string, whereSql: string): Promise<number> =>
    Number(await query(pg, `select count(*) from ${table} where ${whereSql}`));

  /**
   * Every base table in the database, from the catalogue — a table added later is scanned without
   * anyone remembering to list it. `EXCLUDED_TABLES` is the one place to skip a table, with the reason:
   * currently none (migrations here are applied by psql, so there is no `_prisma_migrations`).
   * `withColumn` narrows to tables that have that column (`tenant_id`).
   */
  const EXCLUDED_TABLES: readonly string[] = [];
  async function baseTables(withColumn?: string): Promise<string[]> {
    const narrowing = withColumn
      ? `and exists (select 1 from information_schema.columns c
                     where c.table_schema = t.table_schema and c.table_name = t.table_name
                       and c.column_name = '${withColumn}')`
      : '';
    const rows = await query(
      pg,
      `select quote_ident(t.table_schema) || '.' || quote_ident(t.table_name)
       from information_schema.tables t
       where t.table_type = 'BASE TABLE'
         and t.table_schema not in ('pg_catalog', 'information_schema') ${narrowing}
       order by 1`,
    );
    return rows.split('\n').filter((table) => table !== '' && !EXCLUDED_TABLES.includes(table));
  }

  /**
   * For each table, the rows whose text mentions any needle (and not `exceptMentioning`): count and a
   * digest of their contents. Read from the catalogue, not from the predicates the deletion uses, so it
   * cannot share a blind spot with it. Tables with no such row are absent.
   */
  async function scan(
    needles: readonly string[],
    exceptMentioning?: string,
  ): Promise<Record<string, { rows: number; digest: string }>> {
    const anyNeedle = needles.map((needle) => `t::text like '%${needle}%'`).join(' or ');
    const except = exceptMentioning ? ` and t::text not like '%${exceptMentioning}%'` : '';
    const found: Record<string, { rows: number; digest: string }> = {};
    for (const table of await baseTables()) {
      const [rows, digest] = (
        await query(
          pg,
          `select count(*) || '|' || coalesce(md5(string_agg(t::text, '|' order by t::text)), '')
           from ${table} t where (${anyNeedle})${except}`,
        )
      ).split('|') as [string, string];
      if (Number(rows) > 0) found[table] = { rows: Number(rows), digest };
    }
    return found;
  }
  const mentions = async (needles: readonly string[], exceptMentioning?: string) =>
    Object.fromEntries(
      Object.entries(await scan(needles, exceptMentioning)).map(([table, v]) => [table, v.rows]),
    );
  const mentionDigest = async (needles: readonly string[], exceptMentioning?: string) =>
    JSON.stringify(await scan(needles, exceptMentioning));

  /** Everything that identifies an issue's rows, in any table: its id, evidence, run and content. */
  const needlesOf = (seeded: Seeded): string[] => [
    seeded.id,
    ...seeded.evidenceIds,
    seeded.runId,
    ...seeded.secrets,
  ];
  const mentioned = async (seeded: Seeded, table: string): Promise<number> =>
    (await mentions(needlesOf(seeded)))[table] ?? 0;
  /** What is left of a deleted issue: its tombstone and the announcement, nothing else. */
  const TRACE = { 'audit.deletion_tombstone': 1, 'events.outbox': 1 };

  /** A digest of every row of every table that has a `tenant_id` — proves a tenant untouched. */
  async function tenantDigest(tenantId: string): Promise<string> {
    const parts: string[] = [];
    for (const table of await baseTables('tenant_id')) {
      parts.push(
        `${table}=` +
          (await query(
            pg,
            `select count(*) || ':' || coalesce(md5(string_agg(t::text, '|' order by t::text)), '')
             from ${table} t where tenant_id = '${tenantId}'`,
          )),
      );
    }
    return parts.join('\n');
  }

  /** The rows of one *other* issue, leaving out any row that names the deleted one. */
  const issueDigest = (seeded: Seeded, deletedId: string) =>
    mentionDigest(needlesOf(seeded), deletedId);

  /**
   * Rows of ANOTHER tenant that carry the deleted issue's id (and its evidence's) in the columns that
   * have no foreign key to check them — `audit_entry.target_id`, `outbox.subject_id`,
   * `workflow_run.issue_id` (+ a step and a callback), `agent_run.issue_id`. Ids are globally unique in
   * practice, so only these can prove each statement's own `tenant_id` predicate.
   */
  async function plantForeignRows(gone: Seeded): Promise<void> {
    const t = OTHER_TENANT_ID;
    const run = randomUUID();
    await query(
      pg,
      `insert into "audit"."audit_entry"
         (id, tenant_id, actor_type, actor_ref, action, target_type, target_id, reason, evidence_ids, outcome)
       values ('${randomUUID()}', '${t}', 'human', 'x', 'a', 'issue', '${gone.id}', 'r', '{}', 'ok'),
              ('${randomUUID()}', '${t}', 'human', 'x', 'a', 'evidence', '${gone.evidenceIds[1]}', 'r', '{}', 'ok');
       insert into "events"."outbox" (id, tenant_id, name, subject_id, correlation_id, payload, occurred_at)
       values ('${randomUUID()}', '${t}', 'IssueDetected', '${gone.id}', 'c', '{}', now());
       insert into "workflow"."workflow_run"
         (id, tenant_id, issue_id, definition_key, definition_version, state, correlation_id, updated_at)
       values ('${run}', '${t}', '${gone.id}', 'investigate', 1, 'collecting', '${randomUUID()}', now());
       insert into "workflow"."workflow_transition" (id, tenant_id, run_id, from_state, to_state, cause)
       values ('${randomUUID()}', '${t}', '${run}', 'start', 'collecting', 'job');
       insert into "workflow"."workflow_callback" (id, run_id, tenant_id, kind, token_hash, expires_at)
       values ('${randomUUID()}', '${run}', '${t}', 'ci_result', 'h-${randomUUID()}', now());
       insert into "agent"."agent_run"
         (id, tenant_id, issue_id, correlation_id, agent_kind, prompt_version_id, model_id, provider,
          input_tokens, output_tokens, cost, tool_calls, outcome, started_at)
       values ('${randomUUID()}', '${t}', '${gone.id}', '${randomUUID()}', 'investigator',
               '${promptVersionId}', 'm', 'anthropic', 1, 2, 0.1, '[]', 'ok', now())`,
    );
  }

  /**
   * Holds a transaction open (after `work`, then `after` once released) — what makes a race
   * observable. `pid` is the holder's backend, so `waitForBlocked` can ask about waiters that started
   * after *this* holder rather than any waiter in the database.
   */
  async function hold(
    work: (tx: Prisma.TransactionClient) => Promise<void>,
    after?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    let pid = 0;
    const done = prisma.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await work(tx);
        ready();
        await gate;
        await after?.(tx);
      },
      { timeout: 120_000, maxWait: 60_000 },
    );
    done.catch(() => ready());
    await isReady;
    return {
      pid,
      release: async () => {
        open();
        await done;
      },
    };
  }
  const lockIssue = (id: string) =>
    hold(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "issue"."issue"
        WHERE tenant_id = ${TENANT_ID}::uuid AND id = ${id}::uuid FOR UPDATE`;
    });

  /**
   * Waits until at least `wanted` backends are waiting on a lock **and began that wait after `holder`
   * opened its transaction** — a waiter leaked by an earlier test began before it and does not count.
   * Fails if they never do (no sleeping).
   */
  async function waitForBlocked(wanted: number, holder: { pid: number }): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const waiting = Number(
        await query(
          pg,
          `select count(*) from pg_stat_activity w
           where w.datname = current_database() and w.wait_event_type = 'Lock'
             and w.pid <> ${holder.pid}
             and w.query_start >= (select h.xact_start from pg_stat_activity h where h.pid = ${holder.pid})`,
        ),
      );
      if (waiting >= wanted) return;
      if (Date.now() > deadline) {
        throw new Error(`expected ${wanted} blocked backend(s), saw ${waiting} — nothing waited`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  describe('what is removed', () => {
    it('leaves no row of the issue in any table, and one IssueDeleted', () =>
      inScope(async () => {
        const seeded = await seed();
        const other = await seed();
        await relate(seeded.id, other.id, 'related');
        await relate(other.id, seeded.id, 'related');
        // The fixture reaches every table an issue's data can be in (read from the catalogue).
        expect(Object.keys(await mentions(needlesOf(seeded))).sort()).toEqual([
          'agent.agent_run',
          'audit.audit_entry',
          'events.outbox',
          'evidence.evidence',
          'evidence.evidence_link',
          'issue.issue',
          'issue.issue_event',
          'issue.issue_relationship',
          'workflow.workflow_callback',
          'workflow.workflow_run',
          'workflow.workflow_transition',
        ]);

        const result = await del(seeded.id);

        expect(result.outcome).toBe('deleted');
        // In EVERY table: no row mentioning the issue, its evidence, its run or anything it held —
        // except the tombstone and the announcement that it was deleted.
        expect(await mentions(needlesOf(seeded))).toEqual(TRACE);
        const outbox = await query(
          pg,
          `select name || '|' || payload::text from "events"."outbox" where subject_id = '${seeded.id}'`,
        );
        expect(outbox).toBe(`IssueDeleted|{"tombstoneId": "${result.tombstone.id}"}`);
      }));

    it('takes with it a link from another issue’s conclusion to its evidence — nothing ties a link to an issue', () =>
      inScope(async () => {
        const gone = await seed();
        const other = await seed();
        const link = randomUUID();
        await withStep('diagnose', () =>
          links.write(
            scope(CONTEXT, {
              id: link,
              evidenceId: gone.evidenceIds[1],
              conclusionType: 'diagnosis',
              conclusionId: randomUUID(),
              relation: 'supports',
            }),
          ),
        );
        expect(await mentioned(gone, 'evidence.evidence_link')).toBe(2);

        await del(gone.id);

        expect(await mentions(needlesOf(gone))).toEqual(TRACE);
        expect(await count('"evidence"."evidence_link"', `id = '${link}'`)).toBe(0);
        expect(await mentioned(other, 'evidence.evidence_link')).toBe(1); // the other issue's own
      }));

    it('keeps the agent run — the tenant’s spend — and only forgets which issue it was for', () =>
      inScope(async () => {
        const seeded = await seed();
        const runs = await query(
          pg,
          `select id from "agent"."agent_run" where issue_id = '${seeded.id}'`,
        );

        await del(seeded.id);

        expect(
          await query(
            pg,
            `select issue_id is null || '|' || cost from "agent"."agent_run" where id = '${runs}'`,
          ),
        ).toBe('true|0.500000');
      }));

    it('removes an issue’s relationships in both directions, but not the other issue’s own rows', () =>
      inScope(async () => {
        const gone = await seed();
        const bystander = await seed();
        const third = await seed();
        await relate(gone.id, bystander.id, 'related');
        await relate(bystander.id, gone.id, 'related');
        await relate(gone.id, third.id, 'recurrence_of');
        await relate(bystander.id, third.id, 'related'); // theirs, not the deleted issue's
        const before = await issueDigest(bystander, gone.id);
        const eventsBefore = await count('"issue"."issue_event"', `issue_id = '${bystander.id}'`);

        await del(gone.id);

        expect(
          await count(
            '"issue"."issue_relationship"',
            `issue_id = '${gone.id}' or other_issue_id = '${gone.id}'`,
          ),
        ).toBe(0);
        expect(await issueDigest(bystander, gone.id)).toBe(before);
        expect(await count('"issue"."issue_event"', `issue_id = '${bystander.id}'`)).toBe(
          eventsBefore,
        );
        expect(
          await count(
            '"issue"."issue_relationship"',
            `issue_id = '${bystander.id}' and other_issue_id = '${third.id}'`,
          ),
        ).toBe(1);
      }));

    it('deletes only audit entries about the issue or its evidence — an entry about another issue that cites its evidence stays', () =>
      inScope(async () => {
        const gone = await seed();
        const bystander = await seed();
        const citing = randomUUID();
        await prisma.auditEntry.create({
          data: {
            id: citing,
            tenantId: TENANT_ID,
            actorType: 'human',
            actorRef: 'pavlo',
            action: 'issue.close',
            targetType: 'issue',
            targetId: bystander.id,
            reason: 'basis: the other issue’s evidence',
            evidenceIds: [gone.evidenceIds[0]],
            outcome: 'ok',
          },
        });

        await del(gone.id);

        expect(await count('"audit"."audit_entry"', `id = '${citing}'`)).toBe(1);
        expect(
          await count(
            '"audit"."audit_entry"',
            `target_id = '${gone.id}' or target_id in ('${gone.evidenceIds.join("','")}')`,
          ),
        ).toBe(0);
      }));

    it('leaves another issue in the same tenant, and every row of another tenant — even one carrying the same ids — untouched', () =>
      inScope(async () => {
        const gone = await seed();
        const bystander = await seed();
        const stranger = await seed(OTHER_CONTEXT);
        const strangerNeighbour = await seed(OTHER_CONTEXT);
        await relate(stranger.id, strangerNeighbour.id, 'related', OTHER_TENANT_ID);
        await plantForeignRows(gone);
        const bystanderBefore = await issueDigest(bystander, gone.id);
        const otherTenantBefore = await tenantDigest(OTHER_TENANT_ID);

        await del(gone.id);

        expect(await issueDigest(bystander, gone.id)).toBe(bystanderBefore);
        expect(await tenantDigest(OTHER_TENANT_ID)).toBe(otherTenantBefore);
      }));

    it('reads for the deleted id return nothing: issue, timeline, evidence, graph, audit, relationships', () =>
      inScope(async () => {
        const seeded = await seed();
        await del(seeded.id);
        const where = scope(CONTEXT, { issueId: seeded.id });

        expect(await repo.findById(scope(CONTEXT, { id: seeded.id }))).toBeNull();
        expect(await new PrismaTimelineRepository(prisma).forIssue(where)).toEqual([]);
        expect(await new PrismaEvidenceRepository(prisma).listByIssue(where)).toEqual([]);
        expect(await new PrismaEvidenceGraphRepository(prisma).forIssue(where)).toEqual({
          nodes: [],
          edges: [],
        });
        const audit = new PrismaAuditRepository(prisma);
        expect(
          await audit.listByTarget(scope(CONTEXT, { targetType: 'issue', targetId: seeded.id })),
        ).toEqual([]);
        for (const evidenceId of seeded.evidenceIds) {
          expect(
            await audit.listByTarget(
              scope(CONTEXT, { targetType: 'evidence', targetId: evidenceId }),
            ),
          ).toEqual([]);
        }
        expect(await repo.findRelationships(scope(CONTEXT, { id: seeded.id }))).toEqual([]);
      }));
  });

  describe('the tombstone (R-12)', () => {
    it('holds the identifier, time and requester — and no field derived from what was deleted', () =>
      inScope(async () => {
        const seeded = await seed();

        const { tombstone } = await del(seeded.id, CONTEXT, 'pavlo', REASON);

        expect(tombstone).toEqual({
          id: expect.any(String),
          tenantId: TENANT_ID,
          targetType: 'issue',
          targetId: seeded.id,
          requestedBy: 'pavlo',
          reason: REASON,
          deletedAt: expect.any(Date),
        });
        // Not the domain object — the stored row, whole, as text.
        const stored = await query(
          pg,
          `select t::text from "audit"."deletion_tombstone" t where target_id = '${seeded.id}'`,
        );
        for (const secret of seeded.secrets) expect(stored).not.toContain(secret);
        const columns = await query(
          pg,
          `select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
           where table_schema = 'audit' and table_name = 'deletion_tombstone'`,
        );
        expect(columns).toBe('id,tenant_id,target_type,target_id,requested_by,deleted_at,reason');
      }));

    it('is immutable: no update, delete or truncate — not even with the privileged bypass on', async () => {
      const seeded = await inScopeSeed();
      const { tombstone } = await inScope(() => del(seeded.id));

      const attempt = (sql: string) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('healer.privileged_write', 'on', true)`;
          await tx.$executeRawUnsafe(sql);
        });

      await expect(
        attempt(
          `UPDATE "audit"."deletion_tombstone" SET reason = 'x' WHERE id = '${tombstone.id}'`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        attempt(`DELETE FROM "audit"."deletion_tombstone" WHERE id = '${tombstone.id}'`),
      ).rejects.toThrow(/immutable/);
      await expect(attempt(`TRUNCATE "audit"."deletion_tombstone"`)).rejects.toThrow(/immutable/);
      expect(await count('"audit"."deletion_tombstone"', `id = '${tombstone.id}'`)).toBe(1);
    });

    it('allows one tombstone per target and refuses blank or over-long requester and reason', async () => {
      const seeded = await inScopeSeed();
      const { tombstone } = await inScope(() => del(seeded.id));
      const insert = (over: Record<string, string>) => {
        const row = {
          id: randomUUID(),
          tenant_id: TENANT_ID,
          target_type: 'issue',
          target_id: tombstone.targetId,
          requested_by: 'pavlo',
          reason: 'why',
          ...over,
        };
        return prisma.$executeRawUnsafe(
          `INSERT INTO "audit"."deletion_tombstone" (id, tenant_id, target_type, target_id, requested_by, reason)
           VALUES ('${row.id}', '${row.tenant_id}', '${row.target_type}', '${row.target_id}', '${row.requested_by}', '${row.reason}')`,
        );
      };

      await expect(insert({})).rejects.toThrow(/23505.*\(tenant_id, target_type, target_id\)/);
      const fresh = { target_id: randomUUID() };
      await expect(insert({ ...fresh, requested_by: '  ' })).rejects.toThrow(/requested_by_bounds/);
      await expect(insert({ ...fresh, requested_by: 'x'.repeat(129) })).rejects.toThrow(
        /requested_by_bounds/,
      );
      await expect(insert({ ...fresh, reason: '' })).rejects.toThrow(/reason_bounds/);
      await expect(insert({ ...fresh, reason: 'y'.repeat(501) })).rejects.toThrow(/reason_bounds/);
      await expect(insert({ ...fresh })).resolves.toBe(1);
    });
  });

  describe('who may ask, and what a repeat does', () => {
    it('answers another tenant’s issue, a missing one and a malformed id identically', () =>
      inScope(async () => {
        const seeded = await seed();
        const mine = await tenantDigest(TENANT_ID);

        const results = await Promise.all(
          [del(seeded.id, OTHER_CONTEXT), del(randomUUID()), del('not-a-uuid')].map(settle),
        );

        for (const result of results) {
          expect(result.error).toBeInstanceOf(NotFoundError);
          expect((result.error as Error).message).toBe('Issue not found');
        }
        expect(await tenantDigest(TENANT_ID)).toBe(mine);
        expect(await count('"audit"."deletion_tombstone"', `target_id = '${seeded.id}'`)).toBe(0);
      }));

    it('after the owner deletes it, another tenant asking still gets not-found — not the tombstone', () =>
      inScope(async () => {
        const seeded = await seed();
        await del(seeded.id);

        const result = await settle(del(seeded.id, OTHER_CONTEXT));

        expect(result.error).toBeInstanceOf(NotFoundError);
      }));

    it('is idempotent: a repeat returns the existing tombstone and writes nothing', () =>
      inScope(async () => {
        const seeded = await seed();
        const first = await del(seeded.id, CONTEXT, 'pavlo', 'first reason');
        const before = await tenantDigest(TENANT_ID);

        const second = await del(seeded.id, CONTEXT, 'someone-else', 'second reason');

        expect(second.outcome).toBe('already_deleted');
        expect(second.tombstone).toEqual(first.tombstone); // the first request is the record
        expect(await tenantDigest(TENANT_ID)).toBe(before);
        expect(
          await count('"events"."outbox"', `name = 'IssueDeleted' and subject_id = '${seeded.id}'`),
        ).toBe(1);
      }));

    it('the command refuses a blank requester or reason before any lock is taken', () =>
      inScope(async () => {
        const seeded = await seed();
        const blocker = await lockIssue(seeded.id);
        try {
          await expect(
            deleteIssue(deletion, CONTEXT, { id: seeded.id, requestedBy: 'pavlo', reason: ' ' }),
          ).rejects.toThrow(InvalidDeletionRequestError);
        } finally {
          await blocker.release();
        }
        expect(await count('"issue"."issue"', `id = '${seeded.id}'`)).toBe(1);
      }));

    it('refuses to run outside a correlated scope, before locking', async () => {
      const seeded = await inScopeSeed();
      // With the row locked elsewhere, a call that got as far as locking would wait for it.
      const blocker = await lockIssue(seeded.id);
      try {
        await expect(del(seeded.id)).rejects.toThrow(/correlated scope/);
      } finally {
        await blocker.release();
      }
      expect(await count('"issue"."issue"', `id = '${seeded.id}'`)).toBe(1);
    });
  });

  describe('validation at the repository, and the reader of tombstones (R-12)', () => {
    it('the repository refuses bad text itself — a raw call cannot reach the database checks', () =>
      inScope(async () => {
        const seeded = await seed();
        // Locked elsewhere: a call that got as far as locking would wait instead of failing fast.
        const blocker = await lockIssue(seeded.id);
        try {
          for (const [requestedBy, reason] of [
            ['', REASON],
            ['pavlo', ' '],
            ['pavlo', 'a\u0000b'],
            ['x'.repeat(129), REASON],
            ['pavlo', 'y'.repeat(501)],
          ] as const) {
            await expect(del(seeded.id, CONTEXT, requestedBy, reason)).rejects.toThrow(
              InvalidDeletionRequestError,
            );
          }
        } finally {
          await blocker.release();
        }
        expect(await count('"issue"."issue"', `id = '${seeded.id}'`)).toBe(1);
      }));

    it('findTombstone: null while the issue exists, the tombstone once deleted, null for other tenants, unknown and malformed ids', () =>
      inScope(async () => {
        const seeded = await seed();
        const find = (id: string, context = CONTEXT) =>
          deletion.findTombstone(scope(context, { id }));
        expect(await find(seeded.id)).toBeNull();

        const { tombstone } = await del(seeded.id);

        expect(await find(seeded.id)).toEqual(tombstone);
        expect(await find(seeded.id.toUpperCase())).toEqual(tombstone);
        expect(await find(seeded.id, OTHER_CONTEXT)).toBeNull();
        expect(await find(randomUUID())).toBeNull();
        expect(await find('not-a-uuid')).toBeNull();
      }));
  });

  describe('merged issues', () => {
    const merge = (id: string, intoId: string) =>
      repo.merge(scope(CONTEXT, { id, intoId }), 'pavlo', 'dup');

    it('refuses to delete an issue merged into another: the survivor may cite its evidence (FR-009)', () =>
      inScope(async () => {
        const survivor = await seed();
        const gone = await seed();
        await merge(gone.id, survivor.id);
        // The survivor's conclusion cites the merged issue's evidence — legitimate after a merge.
        const survivorsLink = randomUUID();
        await withStep('diagnose', () =>
          links.write(
            scope(CONTEXT, {
              id: survivorsLink,
              evidenceId: gone.evidenceIds[1],
              conclusionType: 'diagnosis',
              conclusionId: randomUUID(),
              relation: 'supports',
            }),
          ),
        );
        const before = await tenantDigest(TENANT_ID);

        const result = await settle(del(gone.id));

        expect(result.error).toBeInstanceOf(IssueMergedIntoAnotherError);
        expect((result.error as IssueMergedIntoAnotherError).survivorId).toBe(survivor.id);
        expect(await tenantDigest(TENANT_ID)).toBe(before);
        expect(await count('"evidence"."evidence_link"', `id = '${survivorsLink}'`)).toBe(1);
        // Once unmerged it is an ordinary issue again, and goes with all its evidence.
        await repo.unmerge(scope(CONTEXT, { id: gone.id }), 'pavlo');
        expect((await del(gone.id)).outcome).toBe('deleted');
      }));

    it('deletes an issue that was merged and then removed — unmerge is refused for it, so refusing would strand it', () =>
      inScope(async () => {
        const survivor = await seed();
        const gone = await seed();
        await merge(gone.id, survivor.id);
        await repo.transition(scope(CONTEXT, { id: gone.id }), 'removed', 'human', 'pavlo');
        const survivorBefore = await issueDigest(survivor, gone.id);

        expect((await del(gone.id)).outcome).toBe('deleted');

        expect(await mentions(needlesOf(gone))).toEqual(TRACE);
        expect(await issueDigest(survivor, gone.id)).toBe(survivorBefore);
      }));

    it('deletes a non-merged issue together with the links to its own evidence', () =>
      inScope(async () => {
        const gone = await seed();
        expect(await mentioned(gone, 'evidence.evidence_link')).toBe(1);

        await del(gone.id);

        expect(await mentioned(gone, 'evidence.evidence_link')).toBe(0);
      }));

    it('refuses to delete a survivor other issues are merged into, changing nothing', () =>
      inScope(async () => {
        const survivor = await seed();
        const child = await seed();
        await merge(child.id, survivor.id);
        const before = await tenantDigest(TENANT_ID);

        const result = await settle(del(survivor.id));

        expect(result.error).toBeInstanceOf(IssueHasMergedChildrenError);
        expect((result.error as IssueHasMergedChildrenError).childIds).toEqual([child.id]);
        expect(await tenantDigest(TENANT_ID)).toBe(before);
        // Once the child is unmerged the same request goes through.
        await repo.unmerge(scope(CONTEXT, { id: child.id }), 'pavlo');
        expect((await del(survivor.id)).outcome).toBe('deleted');
        expect(await repo.findById(scope(CONTEXT, { id: child.id }))).not.toBeNull();
      }));

    it('deletes a survivor whose only merged child has since been removed', () =>
      inScope(async () => {
        const survivor = await seed();
        const child = await seed();
        await merge(child.id, survivor.id);
        await repo.transition(scope(CONTEXT, { id: child.id }), 'removed', 'human', 'pavlo');

        expect((await del(survivor.id)).outcome).toBe('deleted');
        expect(await repo.findById(scope(CONTEXT, { id: child.id }))).toMatchObject({
          state: 'removed',
        });
        expect(
          await count('"issue"."issue_relationship"', `other_issue_id = '${survivor.id}'`),
        ).toBe(0);
      }));
  });

  describe('atomicity and the append-only bypass', () => {
    it('rolls everything back when the last write fails, including the tombstone', () =>
      inScope(async () => {
        const seeded = await seed();
        const before = await tenantDigest(TENANT_ID);
        await query(
          pg,
          `create function public.fail_issue_deleted() returns trigger language plpgsql as
             $$ begin if new.name = 'IssueDeleted' then raise exception 'boom'; end if; return new; end $$;
           create trigger fail_issue_deleted before insert on "events"."outbox"
             for each row execute function public.fail_issue_deleted();`,
        );
        try {
          await expect(del(seeded.id)).rejects.toThrow(/boom/);
        } finally {
          await query(pg, `drop trigger fail_issue_deleted on "events"."outbox"`);
        }

        expect(await tenantDigest(TENANT_ID)).toBe(before);
        expect(await count('"audit"."deletion_tombstone"', `target_id = '${seeded.id}'`)).toBe(0);
        // …and the retry after the fault clears is a normal deletion.
        expect((await del(seeded.id)).outcome).toBe('deleted');
      }));

    it('a final DELETE that removes no row is an integrity failure, not a tombstone for a live issue', () =>
      inScope(async () => {
        const seeded = await seed();
        const before = await tenantDigest(TENANT_ID);
        await query(
          pg,
          `create function public.skip_issue_delete() returns trigger language plpgsql as
             $$ begin return null; end $$;
           create trigger skip_issue_delete before delete on "issue"."issue"
             for each row when (old.id = '${seeded.id}') execute function public.skip_issue_delete();`,
        );
        try {
          const result = await settle(del(seeded.id));

          expect(result.error).toBeInstanceOf(DeletionIntegrityError);
          expect((result.error as DeletionIntegrityError).reason).toBe('issue_not_deleted');
        } finally {
          await query(pg, `drop trigger skip_issue_delete on "issue"."issue"`);
        }
        expect(await tenantDigest(TENANT_ID)).toBe(before); // every earlier delete rolled back too
      }));

    it('a tombstone that already exists for an issue that still exists is a typed integrity error', () =>
      inScope(async () => {
        const seeded = await seed();
        await query(
          pg,
          `insert into "audit"."deletion_tombstone" (id, tenant_id, target_type, target_id, requested_by, reason)
           values ('${randomUUID()}', '${TENANT_ID}', 'issue', '${seeded.id}', 'someone', 'stray')`,
        );
        const before = await tenantDigest(TENANT_ID);

        const result = await settle(del(seeded.id));

        expect(result.error).toBeInstanceOf(DeletionIntegrityError);
        expect((result.error as DeletionIntegrityError).reason).toBe('tombstone_for_live_issue');
        expect(await tenantDigest(TENANT_ID)).toBe(before);
      }));

    it('does not leave the bypass on after a deletion or a failed one (single connection)', () =>
      inScope(async () => {
        const single = new PrismaClient({ datasourceUrl: `${pg.url}?connection_limit=1` });
        extraClients.push(single);
        const deleting = new PrismaIssueDeletionRepository(single);
        const seeded = await seed();
        const survivor = await seed();

        await deleting.deleteIssue(scope(CONTEXT, { id: seeded.id }), 'pavlo', REASON);
        await expect(
          deleting.deleteIssue(scope(CONTEXT, { id: randomUUID() }), 'pavlo', REASON),
        ).rejects.toBeInstanceOf(NotFoundError);

        // The very connection that ran both: a plain DELETE must still be refused.
        await expect(
          single.$executeRaw`DELETE FROM "evidence"."evidence" WHERE id = ${survivor.evidenceIds[1]}::uuid`,
        ).rejects.toThrow(/append-only/);
        expect(await count('"evidence"."evidence"', `id = '${survivor.evidenceIds[1]}'`)).toBe(1);
      }));
  });

  describe('races (held-open transactions, observed through pg_stat_activity)', () => {
    it('two concurrent deletions: one deletes, the other returns its tombstone, one IssueDeleted', () =>
      inScope(async () => {
        const seeded = await seed();
        const blocker = await lockIssue(seeded.id);
        const a = settle(del(seeded.id, CONTEXT, 'first', 'a'));
        const b = settle(del(seeded.id, CONTEXT, 'second', 'b'));
        await waitForBlocked(2, blocker);
        await blocker.release();

        const [ra, rb] = [await a, await b];

        const outcomes = [ra.value?.outcome, rb.value?.outcome].sort();
        expect(outcomes).toEqual(['already_deleted', 'deleted']);
        expect(ra.value?.tombstone.id).toBe(rb.value?.tombstone.id);
        expect(await count('"audit"."deletion_tombstone"', `target_id = '${seeded.id}'`)).toBe(1);
        expect(
          await count('"events"."outbox"', `name = 'IssueDeleted' and subject_id = '${seeded.id}'`),
        ).toBe(1);
      }));

    it('a signal that is mid-commit: the deletion waits for it, then removes its event too', () =>
      inScope(async () => {
        const seeded = await seed();
        // Exactly what `recordOccurrence` does: lock the issue row, then write an event.
        const signal = await hold(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "issue"."issue"
            WHERE tenant_id = ${TENANT_ID}::uuid AND id = ${seeded.id}::uuid FOR UPDATE`;
          await tx.issueEvent.create({
            data: {
              id: randomUUID(),
              tenantId: TENANT_ID,
              issueId: seeded.id,
              type: 'signal_received',
              cause: 'ingestion',
              actorRef: 'ingest',
              payload: {},
              observedAt: WHEN,
            },
          });
        });
        const deleting = settle(del(seeded.id));
        await waitForBlocked(1, signal);
        await signal.release();

        expect((await deleting).value?.outcome).toBe('deleted');
        expect(await mentions(needlesOf(seeded))).toEqual(TRACE);
      }));

    it('evidence recorded mid-commit (holding a share of the issue row) is removed too', () =>
      inScope(async () => {
        const seeded = await seed();
        const late = randomUUID();
        const recording = await hold(async (tx) => {
          await tx.evidence.create({
            data: {
              id: late,
              tenantId: TENANT_ID,
              issueId: seeded.id,
              type: 'error_signature',
              sourceSystem: 'loki',
              sourceRef: 'r',
              sourceLabel: 'l',
              payload: {},
              producedByStep: 'collector',
              observedAt: WHEN,
              expiresAt: new Date('2027-01-01T00:00:00Z'),
            },
          });
        });
        const deleting = settle(del(seeded.id));
        await waitForBlocked(1, recording);
        await recording.release();

        expect((await deleting).value?.outcome).toBe('deleted');
        expect(await count('"evidence"."evidence"', `id = '${late}'`)).toBe(0);
      }));

    it('a conclusion link that is uncommitted when the deletion starts: it finishes first, then goes with the evidence', () =>
      inScope(async () => {
        const seeded = await seed();
        const linking = await hold(async (tx) => {
          await tx.$executeRaw`SELECT set_config('healer.current_step', 'diagnose', true)`;
          await tx.evidenceLink.create({
            data: {
              id: randomUUID(),
              tenantId: TENANT_ID,
              evidenceId: seeded.evidenceIds[1],
              conclusionType: 'diagnosis',
              conclusionId: randomUUID(),
              relation: 'supports',
              assertedByStep: 'diagnose',
            },
          });
        });
        const deleting = settle(del(seeded.id));
        await waitForBlocked(1, linking);
        await linking.release();

        const result = await deleting;

        expect(result.error).toBeUndefined();
        expect(await mentions(needlesOf(seeded))).toEqual(TRACE);
      }));

    it('a transition mid-commit is waited for, and its event goes with the issue', () =>
      inScope(async () => {
        const seeded = await seed();
        const transitioning = await hold(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "issue"."issue"
            WHERE tenant_id = ${TENANT_ID}::uuid AND id = ${seeded.id}::uuid FOR UPDATE`;
          await tx.issue.update({
            where: { id_tenantId: { id: seeded.id, tenantId: TENANT_ID } },
            data: { state: 'diagnosed' },
          });
        });
        const deleting = settle(del(seeded.id));
        await waitForBlocked(1, transitioning);
        await transitioning.release();

        expect((await deleting).value?.outcome).toBe('deleted');
        expect(await repo.findById(scope(CONTEXT, { id: seeded.id }))).toBeNull();
      }));

    it('a merge queued before the deletion wins: the deletion is then refused, the merge stands', () =>
      inScope(async () => {
        const survivor = await seed();
        const child = await seed();
        const blocker = await lockIssue(survivor.id);
        const merging = settle(
          repo.merge(scope(CONTEXT, { id: child.id, intoId: survivor.id }), 'pavlo', 'dup'),
        );
        await waitForBlocked(1, blocker);
        const deleting = settle(del(survivor.id));
        await waitForBlocked(2, blocker);
        await blocker.release();

        expect((await merging).value?.outcome).toBe('merged');
        expect((await deleting).error).toBeInstanceOf(IssueHasMergedChildrenError);
        expect(await repo.findById(scope(CONTEXT, { id: survivor.id }))).not.toBeNull();
      }));

    it('a deletion queued before the merge wins: the merge finds no target, the child is untouched', () =>
      inScope(async () => {
        const survivor = await seed();
        const child = await seed();
        const childBefore = await issueDigest(child, survivor.id);
        const blocker = await lockIssue(survivor.id);
        const deleting = settle(del(survivor.id));
        await waitForBlocked(1, blocker);
        const merging = settle(
          repo.merge(scope(CONTEXT, { id: child.id, intoId: survivor.id }), 'pavlo', 'dup'),
        );
        await waitForBlocked(2, blocker);
        await blocker.release();

        expect((await deleting).value?.outcome).toBe('deleted');
        expect((await merging).error).toBeInstanceOf(NotFoundError);
        expect(await issueDigest(child, survivor.id)).toBe(childBefore);
        expect((await repo.findById(scope(CONTEXT, { id: child.id })))?.state).toBe(
          'investigating',
        );
      }));

    it('a lock wait longer than the time limit is DeletionTimedOutError — not "concurrent, retry" — and changes nothing', () =>
      inScope(async () => {
        const seeded = await seed();
        const before = await tenantDigest(TENANT_ID);
        const quick = new PrismaIssueDeletionRepository(prisma, { lockTimeoutMs: 400 });
        const blocker = await lockIssue(seeded.id);
        const deleting = settle(
          quick.deleteIssue(scope(CONTEXT, { id: seeded.id }), 'pavlo', REASON),
        );
        await waitForBlocked(1, blocker);

        const { error } = await deleting; // gives up on its own after ~400 ms of waiting, the holder still open

        expect(error).toBeInstanceOf(DeletionTimedOutError);
        expect(error).not.toBeInstanceOf(ConcurrentModificationError);
        await blocker.release();
        expect(await tenantDigest(TENANT_ID)).toBe(before);
        // The same request with the default (generous) bound then goes through.
        expect((await del(seeded.id)).outcome).toBe('deleted');
      }));

    it('a transaction that overruns its own time limit is DeletionTimedOutError too, and rolls back', () =>
      inScope(async () => {
        const seeded = await seed();
        const before = await tenantDigest(TENANT_ID);
        const hasty = new PrismaIssueDeletionRepository(prisma, { timeoutMs: 1 });

        const { error } = await settle(
          hasty.deleteIssue(scope(CONTEXT, { id: seeded.id }), 'pavlo', REASON),
        );

        expect(error).toBeInstanceOf(DeletionTimedOutError);
        expect(await tenantDigest(TENANT_ID)).toBe(before);
      }));

    it('a deadlock with an outside transaction surfaces as ConcurrentModificationError', () =>
      inScope(async () => {
        const seeded = await seed();
        const patient = new PrismaClient({ datasourceUrl: `${pg.url}?connection_limit=1` });
        extraClients.push(patient);
        await patient.$executeRaw`SET deadlock_timeout = '5s'`;
        // The outsider holds the issue's evidence and — once released — reaches for the issue row, which
        // the deletion holds while it waits for the evidence. Its own deadlock check is far out, the
        // deletion's (five seconds) fires first: the deletion is the victim.
        const outsider = await hold(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL deadlock_timeout = '60s'`;
            await tx.$queryRaw`SELECT id FROM "evidence"."evidence"
              WHERE tenant_id = ${TENANT_ID}::uuid AND issue_id = ${seeded.id}::uuid FOR UPDATE`;
          },
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "issue"."issue" WHERE id = ${seeded.id}::uuid FOR UPDATE`;
          },
        );
        const deleting = settle(
          new PrismaIssueDeletionRepository(patient).deleteIssue(
            scope(CONTEXT, { id: seeded.id }),
            'pavlo',
            REASON,
          ),
        );
        await waitForBlocked(1, outsider);
        await outsider.release();

        const { error } = await deleting;

        expect(error).toBeInstanceOf(ConcurrentModificationError);
        expect(await count('"issue"."issue"', `id = '${seeded.id}'`)).toBe(1);
      }));

    describe('an event about the issue that a drain worker has claimed', () => {
      const claim = (id: string, sql = 'now()') =>
        query(
          pg,
          `update "events"."outbox" set claimed_at = ${sql} where subject_id = '${id}' and published_at is null`,
        );

      it('refuses, changing nothing — the worker would publish it after the deletion', () =>
        inScope(async () => {
          const seeded = await seed();
          await claim(seeded.id);
          const before = await tenantDigest(TENANT_ID);

          const result = await settle(del(seeded.id));

          expect(result.error).toBeInstanceOf(IssueEventsInFlightError);
          expect(await tenantDigest(TENANT_ID)).toBe(before);
        }));

      it('ignores a claim older than the drain’s own claim timeout, and one on a row already published', () =>
        inScope(async () => {
          const stale = await seed();
          await claim(stale.id, `now() - interval '6 minutes'`);
          expect((await del(stale.id)).outcome).toBe('deleted');

          const published = await seed();
          await query(
            pg,
            `update "events"."outbox" set claimed_at = now(), published_at = now()
             where subject_id = '${published.id}'`,
          );
          expect((await del(published.id)).outcome).toBe('deleted');
        }));

      it('waits for a claim that is still being committed, then sees it and refuses', () =>
        inScope(async () => {
          const seeded = await seed();
          // What the drain's claim `UPDATE` does, held before it commits.
          const claiming = await hold(async (tx) => {
            await tx.$executeRaw`UPDATE "events"."outbox" SET claimed_at = now()
              WHERE subject_id = ${seeded.id} AND published_at IS NULL`;
          });
          const deleting = settle(del(seeded.id));
          await waitForBlocked(1, claiming);
          await claiming.release();

          expect((await deleting).error).toBeInstanceOf(IssueEventsInFlightError);
          expect(await count('"issue"."issue"', `id = '${seeded.id}'`)).toBe(1);
        }));
    });

    describe('against a retention run on the same evidence', () => {
      /** The append-only trigger forbids editing `expires_at`, so expiry is set on a fresh row. */
      async function withExpiredEvidence(): Promise<{ seeded: Seeded; expired: string }> {
        const seeded = await inScopeSeed();
        const expired = randomUUID();
        await prisma.evidence.create({
          data: {
            id: expired,
            tenantId: TENANT_ID,
            issueId: seeded.id,
            type: 'error_signature',
            sourceSystem: 'loki',
            sourceRef: 'r',
            sourceLabel: 'l',
            payload: {},
            producedByStep: 'collector',
            observedAt: WHEN,
            expiresAt: new Date('2026-01-02T00:00:00Z'),
          },
        });
        return { seeded, expired };
      }

      const holdEvidence = (id: string) =>
        hold(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "evidence"."evidence" WHERE id = ${id}::uuid FOR UPDATE`;
        });
      const NOW = new Date('2026-06-01T00:00:00Z');

      it('purge queued first: the purge runs, the deletion finishes the rest', async () => {
        const { seeded, expired } = await withExpiredEvidence();
        const retention = new PrismaEvidenceRetentionRepository(prisma);
        const blocker = await holdEvidence(expired);
        const purging = settle(retention.purge(scope(CONTEXT, { id: expired, now: NOW })));
        await waitForBlocked(1, blocker);
        const deleting = settle(inScope(() => del(seeded.id)));
        await waitForBlocked(2, blocker);
        await blocker.release();

        expect((await purging).value).toBe(true);
        expect((await deleting).value?.outcome).toBe('deleted');
        expect(await mentioned(seeded, 'evidence.evidence')).toBe(0);
        // The purge's audit entry names an evidence id and a fact, never this issue, so it stays.
        expect(await count('"audit"."audit_entry"', `target_id = '${expired}'`)).toBe(1);
      });

      it('deletion queued first: the purge finds nothing to do and writes no audit entry', async () => {
        const { seeded, expired } = await withExpiredEvidence();
        const retention = new PrismaEvidenceRetentionRepository(prisma);
        const blocker = await holdEvidence(expired);
        const deleting = settle(inScope(() => del(seeded.id)));
        await waitForBlocked(1, blocker);
        const purging = settle(retention.purge(scope(CONTEXT, { id: expired, now: NOW })));
        await waitForBlocked(2, blocker);
        await blocker.release();

        expect((await deleting).value?.outcome).toBe('deleted');
        expect((await purging).value).toBe(false);
        expect(await count('"audit"."audit_entry"', `target_id = '${expired}'`)).toBe(0);
      });
    });
  });

  describe('nothing derived is forgotten', () => {
    it('handles every column in the database that names an issue', async () => {
      const found = await query(
        pg,
        `select string_agg(table_schema || '.' || table_name || '.' || column_name, ',')
         from information_schema.columns
         where column_name in ('issue_id', 'other_issue_id')
           and table_schema not in ('information_schema', 'pg_catalog')`,
      );

      // A new table that names an issue fails here until `prisma-issue-deletion.ts` handles it.
      expect(found.split(',').sort()).toEqual([...ISSUE_ID_COLUMNS].sort());
    });
  });

  describe('migration ' + TOMBSTONE_MIGRATION, () => {
    it('reverses cleanly and re-applies (down.sql)', async () => {
      const dir = `${MIGRATIONS_DIR}${TOMBSTONE_MIGRATION}/`;
      expect(readFileSync(`${dir}down.sql`, 'utf8')).toContain('deletion_tombstone_immutable');

      await applySqlFile(pg, `${dir}down.sql`);
      const remaining = await query(
        pg,
        `select count(*) from pg_trigger where tgname like 'deletion_tombstone_%'`,
      );
      expect(remaining).toBe('0');
      expect(
        await query(
          pg,
          `select count(*) from pg_indexes where indexname like 'deletion_tombstone_tenant_id_target%'`,
        ),
      ).toBe('0');

      await applySqlFile(pg, `${dir}migration.sql`);
      expect(
        await query(pg, `select count(*) from pg_trigger where tgname like 'deletion_tombstone_%'`),
      ).toBe('2');
    });
  });
});
