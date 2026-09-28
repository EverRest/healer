import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  ConcurrentModificationError,
  InvalidIssueTransitionError,
  PrismaAuditRepository,
  PrismaIssueRepository,
  closeIssue,
  type ClosingRepository,
  type NewIssue,
} from '@healer/domain-issues';
import { TenantContext, newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `IssueResolved` against a real database (001 T054/T057, FR-021, C-09, quickstart 24): resolved
 * means verified, except when a person closes the issue — and then it says so (`self_resolved`,
 * no verification evidence). Nothing else may emit it: not a merge, not a state change of any
 * other kind. The verified emitters (`remediated`, `fixed`) do not exist yet, so what is proven
 * here is the negative space around the one producer that does.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000d1';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

function newIssue(overrides: Partial<NewIssue> = {}): NewIssue {
  return {
    id: randomUUID(),
    kind: 'production_incident',
    environment: 'prod',
    severity: 'high',
    fingerprint: `fp-${randomUUID()}`,
    rulesetVersion: 1,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('IssueResolved (001 T054/T057, FR-021, C-09, quickstart 24)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaIssueRepository;
  let audit: PrismaAuditRepository;

  const id = (issueId: string) => scope(CONTEXT, { id: issueId });

  /** Every IssueResolved payload published for the issue, oldest first. */
  async function resolvedEvents(issueId: string): Promise<unknown[]> {
    const rows = await prisma.outbox.findMany({
      where: { tenantId: TENANT_ID, subjectId: issueId, name: 'IssueResolved' },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((row) => row.payload);
  }

  const auditCount = async (issueId: string): Promise<number> =>
    (await audit.listByTarget(scope(CONTEXT, { targetType: 'issue', targetId: issueId }))).length;

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
    audit = new PrismaAuditRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('a human resolution publishes exactly one IssueResolved(self_resolved) with no verification evidence', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await repo.transition(id(input.id), 'resolved', 'human', 'pavlo');

      expect(await resolvedEvents(input.id)).toEqual([
        { resolutionKind: 'self_resolved', verificationEvidenceIds: [] },
      ]);
    }));

  it('a resolution the state machine refuses publishes nothing and leaves the state alone (validation only — atomicity is the rollback test below)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await repo.transition(id(input.id), 'investigating', 'agent', 'x');

      await expect(repo.transition(id(input.id), 'resolved', 'agent', 'verifier')).rejects.toThrow(
        InvalidIssueTransitionError,
      );

      expect(await resolvedEvents(input.id)).toEqual([]);
      expect((await repo.findById(id(input.id)))?.state).toBe('investigating');
    }));

  it('no other transition publishes it — not a merge, not a reopen, not staleness, not removal', () =>
    withCorrelation(newCorrelationId(), async () => {
      // `merged` is reached through the merge operation, the only door (001 T049) — a plain
      // transition to it is refused because it would leave no `merged_into` row.
      const target = newIssue();
      await repo.create(scope(CONTEXT, target));
      const merged = newIssue();
      await repo.create(scope(CONTEXT, merged));
      await repo.transition(id(merged.id), 'investigating', 'agent', 'x');
      await repo.transition(id(merged.id), 'diagnosed', 'agent', 'x');
      await repo.transition(id(merged.id), 'acting', 'agent', 'x');
      await repo.transition(id(merged.id), 'needs_human', 'policy', 'gate');
      await repo.transition(id(merged.id), 'stale', 'system', 'sweep');
      await repo.merge(
        scope(CONTEXT, { id: merged.id, intoId: target.id }),
        'pavlo',
        'duplicate of the target',
      );
      await repo.transition(id(merged.id), 'removed', 'policy', 'deletion');
      expect(await resolvedEvents(merged.id)).toEqual([]);

      // The interesting case: the *already resolved* issue that is then reopened, merged and
      // removed. Each later transition must add nothing to the one resolution it already has.
      const resolved = newIssue();
      await repo.create(scope(CONTEXT, resolved));
      await repo.transition(id(resolved.id), 'resolved', 'human', 'pavlo');
      await repo.transition(id(resolved.id), 'investigating', 'ingestion', 'signal');
      await repo.transition(id(resolved.id), 'resolved', 'human', 'pavlo');
      await repo.merge(
        scope(CONTEXT, { id: resolved.id, intoId: target.id }),
        'pavlo',
        'duplicate of the target',
      );
      await repo.transition(id(resolved.id), 'removed', 'policy', 'deletion');
      expect(await resolvedEvents(resolved.id)).toHaveLength(2); // one per human resolution
    }));

  it('records the close reason on the state_changed event, not on an event the contract does not name', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await repo.transition(id(input.id), 'resolved', 'human', 'pavlo', 'fixed it by hand');

      const payload = await query(
        pg,
        `select payload->>'reason' from "issue"."issue_event"
         where issue_id = '${input.id}' and type = 'state_changed'`,
      );
      expect(payload).toBe('fixed it by hand');
    }));
  it('a human transition with an audit spec writes the audit entry for that human, in the same commit', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await repo.transition(id(input.id), 'resolved', 'human', 'pavlo', 'fixed by hand', {
        action: 'issue.close',
      });

      const entries = await audit.listByTarget(
        scope(CONTEXT, { targetType: 'issue', targetId: input.id }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorType: 'human',
        actorRef: 'pavlo',
        action: 'issue.close',
        reason: 'fixed by hand',
        evidenceIds: [],
        outcome: 'ok',
      });
    }));

  it('an audit spec without a reason, or on a non-human cause, is refused before anything is written', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await expect(
        repo.transition(id(input.id), 'resolved', 'human', 'pavlo', undefined, { action: 'x' }),
      ).rejects.toThrow(/audit/);
      await expect(
        repo.transition(id(input.id), 'investigating', 'agent', 'x', 'why', { action: 'x' }),
      ).rejects.toThrow(/audit/);

      expect((await repo.findById(id(input.id)))?.state).toBe('detected');
      expect(await auditCount(input.id)).toBe(0);
    }));

  it('the state change, its event, the audit entry and both outbox rows commit or roll back together', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      // A real database failure on the *last* write of the transaction, after the state UPDATE,
      // the issue_event, the IssueStateChanged row and the audit entry have all been issued.
      await query(
        pg,
        `create or replace function public.fail_issue_resolved() returns trigger language plpgsql as
           $$ begin if new.name = 'IssueResolved' then raise exception 'induced outbox failure'; end if; return new; end $$;
         create trigger fail_issue_resolved before insert on "events"."outbox"
           for each row execute function public.fail_issue_resolved();`,
      );
      try {
        await expect(
          repo.transition(id(input.id), 'resolved', 'human', 'pavlo', 'why', {
            action: 'issue.close',
          }),
        ).rejects.toThrow(/induced outbox failure/);
      } finally {
        await query(pg, `drop trigger fail_issue_resolved on "events"."outbox"`);
      }

      expect((await repo.findById(id(input.id)))?.state).toBe('detected');
      expect((await repo.findById(id(input.id)))?.resolvedAt).toBeNull();
      const events = await query(
        pg,
        `select count(*) from "issue"."issue_event" where issue_id = '${input.id}' and type = 'state_changed'`,
      );
      expect(events).toBe('0');
      expect(await auditCount(input.id)).toBe(0);
      const outboxNames = await query(
        pg,
        `select string_agg(name, ',') from "events"."outbox" where subject_id = '${input.id}'`,
      );
      expect(outboxNames).toBe('IssueDetected');
    }));

  describe('closeIssue against real contention (001 T057)', () => {
    /** Holds a transaction that has already written to the issue row, until `release()`. The
     *  close is started while it is open, so its serialisable UPDATE provably blocks on the row
     *  lock and then loses to the commit — no sleeps deciding whether the conflict happens. */
    async function withHeldWrite(
      issueId: string,
      write: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<unknown>,
      whileHeld: () => Promise<unknown>,
    ): Promise<void> {
      let release!: () => void;
      const mayCommit = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const isHeld = new Promise<void>((resolve) => (held = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await write(tx);
          held();
          await mayCommit;
        },
        { timeout: 60_000 },
      );
      await isHeld;
      const pending = whileHeld();
      for (let waited = 0; ; waited += 50) {
        const blocked = await query(
          pg,
          `select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
        );
        if (blocked !== '0') break;
        if (waited > 15_000) throw new Error(`nothing blocked on ${issueId}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      release();
      await holder;
      await pending;
    }

    const counting = () => {
      const calls = { transition: 0 };
      const closing: ClosingRepository = {
        findById: (where) => repo.findById(where),
        transition: (...args) => {
          calls.transition += 1;
          return repo.transition(...args);
        },
      };
      return { calls, closing };
    };

    const touch = (issueId: string) => (tx: { $executeRaw: PrismaClient['$executeRaw'] }) =>
      tx.$executeRaw`UPDATE "issue"."issue" SET occurrence_count = occurrence_count + 1
                     WHERE id = ${issueId}::uuid AND tenant_id = ${TENANT_ID}::uuid`;

    it('a signal landing mid-close conflicts once, and the retry closes it', () =>
      withCorrelation(newCorrelationId(), async () => {
        const input = newIssue();
        await repo.create(scope(CONTEXT, input));
        const { calls, closing } = counting();
        let result: Awaited<ReturnType<typeof closeIssue>> | undefined;

        await withHeldWrite(input.id, touch(input.id), async () => {
          result = await closeIssue(closing, CONTEXT, input.id, 'pavlo', 'why');
        });

        expect(result).toMatchObject({ closed: true, issue: { state: 'resolved' } });
        expect(calls.transition).toBe(2); // the first attempt provably lost, the second won
        expect(await resolvedEvents(input.id)).toHaveLength(1);
        expect(await auditCount(input.id)).toBe(1);
      }));

    it('losing to a concurrent close is a no-op after one attempt — not a retry, not an error', () =>
      withCorrelation(newCorrelationId(), async () => {
        const input = newIssue();
        await repo.create(scope(CONTEXT, input));
        const { calls, closing } = counting();
        let result: Awaited<ReturnType<typeof closeIssue>> | undefined;

        await withHeldWrite(
          input.id,
          (tx) =>
            tx.$executeRaw`UPDATE "issue"."issue" SET state = 'resolved'::"issue"."issue_state"
                           WHERE id = ${input.id}::uuid AND tenant_id = ${TENANT_ID}::uuid`,
          async () => {
            result = await closeIssue(closing, CONTEXT, input.id, 'pavlo', 'why');
          },
        );

        expect(result).toMatchObject({ closed: false, issue: { state: 'resolved' } });
        expect(calls.transition).toBe(1);
        expect(await auditCount(input.id)).toBe(0); // the loser wrote nothing
      }));

    it('the state moving to something else mid-close is a genuine conflict — surfaced, not retried, not swallowed', () =>
      withCorrelation(newCorrelationId(), async () => {
        const input = newIssue();
        await repo.create(scope(CONTEXT, input));
        const { calls, closing } = counting();
        let outcome: unknown;

        await withHeldWrite(
          input.id,
          (tx) =>
            tx.$executeRaw`UPDATE "issue"."issue" SET state = 'stale'::"issue"."issue_state"
                           WHERE id = ${input.id}::uuid AND tenant_id = ${TENANT_ID}::uuid`,
          async () => {
            outcome = await closeIssue(closing, CONTEXT, input.id, 'pavlo', 'why').catch(
              (error: unknown) => error,
            );
          },
        );

        expect(outcome).toBeInstanceOf(ConcurrentModificationError);
        expect(calls.transition).toBe(1);
        expect((await repo.findById(id(input.id)))?.state).toBe('stale');
        expect(await resolvedEvents(input.id)).toEqual([]);
      }));
  });
});
