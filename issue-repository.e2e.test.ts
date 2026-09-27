import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  ConcurrentModificationError,
  InvalidIssueTransitionError,
  PrismaIssueRepository,
  type NewIssue,
} from '@healer/domain-issues';
import {
  NotFoundError,
  TenantContext,
  newCorrelationId,
  scope,
  withCorrelation,
} from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `PrismaIssueRepository` (001 T012, FR-006): create, read and `transition` only — `transition`
 * writes the new `state` and the `issue_event` that records its cause in one operation, so a
 * state change with no event is not something this repository can do by accident.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000e1';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000e2';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);

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

describe('PrismaIssueRepository (001 T012, FR-006)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaIssueRepository;

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

  it('creates an issue in detected and reads it back for the owning tenant', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      const created = await repo.create(scope(CONTEXT, input));
      expect(created).toMatchObject({
        id: input.id,
        tenantId: TENANT_ID,
        state: 'detected',
        fingerprint: input.fingerprint,
        rulesetVersion: 1,
        occurrenceCount: 1n,
      });

      const found = await repo.findById(scope(CONTEXT, { id: input.id }));
      expect(found).toMatchObject({ id: input.id, state: 'detected' });
    }));

  it('never returns another tenant’s issue — the query itself is tenant-scoped', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      const foundByOtherTenant = await repo.findById(scope(OTHER_CONTEXT, { id: input.id }));
      expect(foundByOtherTenant).toBeNull();
    }));

  it('returns null for an id that does not exist at all', async () => {
    expect(await repo.findById(scope(CONTEXT, { id: randomUUID() }))).toBeNull();
  });

  it('transition moves the state and records the issue_event in one operation', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      const moved = await repo.transition(
        scope(CONTEXT, { id: input.id }),
        'investigating',
        'agent',
        'context-resolver',
      );
      expect(moved.state).toBe('investigating');

      const events = await query(
        pg,
        `select from_state, to_state, cause, actor_ref from "issue"."issue_event"
         where issue_id = '${input.id}' and type = 'state_changed'`,
      );
      expect(events).toBe('detected|investigating|agent|context-resolver');
    }));

  it('transition rejects an undeclared edge — the graph is the authority, not the caller', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      await expect(
        repo.transition(scope(CONTEXT, { id: input.id }), 'acting', 'human', 'pavlo'),
      ).rejects.toThrow(/detected -> acting is not a declared transition/);
    }));

  it('transition throws NotFoundError rather than leaking whether another tenant’s issue exists', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      await expect(
        repo.transition(scope(OTHER_CONTEXT, { id: input.id }), 'investigating', 'agent', 'x'),
      ).rejects.toBeInstanceOf(NotFoundError);
    }));

  it('two concurrent transitions from the same state: exactly one wins, never both (review finding)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      // Both edges are legal from 'detected' — the graph alone can't reject either. Without a
      // guard on the state a transition was validated against, both committed (20/20 trials),
      // each writing its own state_changed event as if the other had never happened. The loser
      // sees `ConcurrentModificationError` when its own guarded update loses the race (both reads
      // genuinely overlapped), or `InvalidIssueTransitionError` when it instead reads the
      // already-changed state and the graph itself rejects the now-stale edge — either is a
      // correct rejection; what must never happen is both settling fulfilled. NOTE (QUESTIONS.md
      // "001 review — transition() concurrency test residual flakiness"): this assertion still
      // fails intermittently in this exact file despite the underlying fix (SERIALIZABLE +
      // state-guarded raw UPDATE) reproducing as airtight — 0 failures across 400+ trials — in
      // every isolated, clean-room repro built while investigating it. Root cause not fully
      // pinned down; flagged for follow-up rather than left silently passing or silently deleted.
      const outcomes = await Promise.allSettled([
        repo.transition(scope(CONTEXT, { id: input.id }), 'merged', 'human', 'a'),
        repo.transition(scope(CONTEXT, { id: input.id }), 'investigating', 'agent', 'b'),
      ]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason;
      expect(
        reason instanceof ConcurrentModificationError ||
          reason instanceof InvalidIssueTransitionError,
      ).toBe(true);

      const events = await query(
        pg,
        `select count(*) from "issue"."issue_event"
         where issue_id = '${input.id}' and type = 'state_changed'`,
      );
      expect(events).toBe('1');
    }));

  it('rejects creating an issue against a ruleset_version that was never published — the FK (001 T011)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue({ rulesetVersion: 999 });
      await expect(repo.create(scope(CONTEXT, input))).rejects.toThrow();
    }));

  it('publishing IssueDetected and IssueStateChanged writes the outbox row in the same transaction as the mutation', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await repo.transition(scope(CONTEXT, { id: input.id }), 'investigating', 'agent', 'x');

      const names = await query(
        pg,
        `select string_agg(name, ',' order by occurred_at) from "events"."outbox"
         where subject_id = '${input.id}' and tenant_id = '${TENANT_ID}'`,
      );
      expect(names).toBe('IssueDetected,IssueStateChanged');
    }));

  it('findOpenByFingerprint finds a detected issue by its fingerprint (001 T018, FR-002)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      const found = await repo.findOpenByFingerprint(
        scope(CONTEXT, { fingerprint: input.fingerprint }),
      );
      expect(found).toMatchObject({ id: input.id });
    }));

  it('findOpenByFingerprint does not match a resolved issue — that decision belongs to T022', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await repo.transition(scope(CONTEXT, { id: input.id }), 'investigating', 'agent', 'x');
      await repo.transition(scope(CONTEXT, { id: input.id }), 'resolved', 'human', 'pavlo');

      const found = await repo.findOpenByFingerprint(
        scope(CONTEXT, { fingerprint: input.fingerprint }),
      );
      expect(found).toBeNull();
    }));

  it('findOpenByFingerprint never returns another tenant’s issue', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      const found = await repo.findOpenByFingerprint(
        scope(OTHER_CONTEXT, { fingerprint: input.fingerprint }),
      );
      expect(found).toBeNull();
    }));

  it('create records the first occurrence as its own signal_received event (review finding)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      const events = await query(
        pg,
        `select count(*) from "issue"."issue_event"
         where issue_id = '${input.id}' and type = 'signal_received'`,
      );
      expect(events).toBe('1');
    }));

  it('recordOccurrence increments occurrenceCount and advances lastSeenAt, and records a signal_received event', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue({ lastSeenAt: new Date('2026-01-01T00:00:00Z') });
      await repo.create(scope(CONTEXT, input));

      const later = new Date('2026-01-02T00:00:00Z');
      const attached = await repo.recordOccurrence(scope(CONTEXT, { id: input.id }), later);
      expect(attached.occurrenceCount).toBe(2n);
      expect(attached.lastSeenAt).toEqual(later);

      // Two rows now: create()'s own first-occurrence event, plus this one.
      const events = await query(
        pg,
        `select count(*) from "issue"."issue_event"
         where issue_id = '${input.id}' and type = 'signal_received'`,
      );
      expect(events).toBe('2');
    }));

  it('recordOccurrence never loses a concurrent signal — occurrenceCount and lastSeenAt both reflect both, no read-modify-write window', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue({ lastSeenAt: new Date('2026-01-01T00:00:00Z') });
      await repo.create(scope(CONTEXT, input));

      const early = new Date('2026-01-01T00:05:00Z');
      const late = new Date('2026-01-01T00:10:00Z');
      await Promise.all([
        repo.recordOccurrence(scope(CONTEXT, { id: input.id }), late),
        repo.recordOccurrence(scope(CONTEXT, { id: input.id }), early),
      ]);

      const after = await repo.findById(scope(CONTEXT, { id: input.id }));
      // Review finding: a read-modify-write (`current.lastSeenAt` read, compared, written back)
      // let the transaction that read *first* but committed *last* overwrite the later timestamp
      // with its own stale comparison — reproduced 9/20 trials. GREATEST() at the SQL level can't
      // lose this race: both increments are always visible, and the max always wins regardless of
      // commit order.
      expect(after!.occurrenceCount).toBe(3n);
      expect(after!.lastSeenAt).toEqual(late);
    }));

  it('recordOccurrence moves firstSeenAt earlier for an out-of-order (earlier-observed) signal (review finding)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue({
        firstSeenAt: new Date('2026-01-01T00:10:00Z'),
        lastSeenAt: new Date('2026-01-01T00:10:00Z'),
      });
      await repo.create(scope(CONTEXT, input));

      const earlier = new Date('2026-01-01T00:01:00Z');
      const attached = await repo.recordOccurrence(scope(CONTEXT, { id: input.id }), earlier);
      expect(attached.firstSeenAt).toEqual(earlier);
    }));

  it('recordOccurrence never moves lastSeenAt backwards for an out-of-order (earlier) signal', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue({ lastSeenAt: new Date('2026-01-02T00:00:00Z') });
      await repo.create(scope(CONTEXT, input));

      const earlier = new Date('2026-01-01T00:00:00Z');
      const attached = await repo.recordOccurrence(scope(CONTEXT, { id: input.id }), earlier);
      expect(attached.occurrenceCount).toBe(2n);
      expect(attached.lastSeenAt).toEqual(input.lastSeenAt);
    }));

  it('recordOccurrence throws NotFoundError rather than leaking whether another tenant’s issue exists', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      await expect(
        repo.recordOccurrence(scope(OTHER_CONTEXT, { id: input.id }), new Date()),
      ).rejects.toBeInstanceOf(NotFoundError);
    }));
});
