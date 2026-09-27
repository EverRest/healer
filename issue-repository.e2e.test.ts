import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  ConcurrentModificationError,
  FingerprintAlreadyOpenError,
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

  it('returns null, not a 500-causing throw, for a malformed (non-UUID) id (001 T031 review, SC-004)', async () => {
    expect(await repo.findById(scope(CONTEXT, { id: ':issueId' }))).toBeNull();
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

  it('a knowledge_drift issue cannot enter acting or be auto-resolved through the real repository (001 T038, FR-001a)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue({ kind: 'knowledge_drift' });
      await repo.create(scope(CONTEXT, input));
      await repo.transition(scope(CONTEXT, { id: input.id }), 'investigating', 'agent', 'x');
      await repo.transition(scope(CONTEXT, { id: input.id }), 'diagnosed', 'agent', 'x');

      await expect(
        repo.transition(scope(CONTEXT, { id: input.id }), 'acting', 'agent', 'change-agent'),
      ).rejects.toThrow(/knowledge_drift/);

      await repo.transition(scope(CONTEXT, { id: input.id }), 'needs_human', 'policy', 'gate');
      await expect(
        repo.transition(scope(CONTEXT, { id: input.id }), 'resolved', 'agent', 'x'),
      ).rejects.toThrow(/knowledge_drift/);

      const resolved = await repo.transition(
        scope(CONTEXT, { id: input.id }),
        'resolved',
        'human',
        'pavlo',
      );
      expect(resolved.state).toBe('resolved');
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
      // correct rejection; what must never happen is both settling fulfilled. This assertion was
      // intermittently flaky for a real reason (QUESTIONS.md "001 review — transition() concurrency
      // test residual flakiness", now resolved): `transition()`'s catch only recognized Prisma
      // error P2034, but the conflicting statement is a raw `$executeRaw` UPDATE, whose own
      // serialization failure surfaces as P2010 wrapping Postgres SQLSTATE 40001 instead — the
      // exact conflict this test exists to prove was being rethrown unhandled rather than as
      // `ConcurrentModificationError`. Fixed in `prisma-issue-repository.ts`'s `transition()`.
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

  it('transition sets resolvedAt on resolving and clears it on reopen (001 T022, FR-005)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await repo.transition(scope(CONTEXT, { id: input.id }), 'investigating', 'agent', 'x');

      const beforeResolve = new Date();
      const resolved = await repo.transition(
        scope(CONTEXT, { id: input.id }),
        'resolved',
        'human',
        'pavlo',
      );
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.resolvedAt!.getTime()).toBeGreaterThanOrEqual(beforeResolve.getTime());

      const reopened = await repo.transition(
        scope(CONTEXT, { id: input.id }),
        'investigating',
        'ingestion',
        'ingestion',
      );
      expect(reopened.resolvedAt).toBeNull();
    }));

  it('findMostRecentlyResolvedByFingerprint finds a resolved issue by its fingerprint (001 T022, FR-005)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await repo.transition(scope(CONTEXT, { id: input.id }), 'investigating', 'agent', 'x');
      await repo.transition(scope(CONTEXT, { id: input.id }), 'resolved', 'human', 'pavlo');

      const found = await repo.findMostRecentlyResolvedByFingerprint(
        scope(CONTEXT, { fingerprint: input.fingerprint }),
      );
      expect(found).toMatchObject({ id: input.id, state: 'resolved' });
    }));

  it('findMostRecentlyResolvedByFingerprint returns null when nothing sharing the fingerprint is resolved', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));

      const found = await repo.findMostRecentlyResolvedByFingerprint(
        scope(CONTEXT, { fingerprint: input.fingerprint }),
      );
      expect(found).toBeNull();
    }));

  it('findMostRecentlyResolvedByFingerprint never returns another tenant’s issue', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue();
      await repo.create(scope(CONTEXT, input));
      await repo.transition(scope(CONTEXT, { id: input.id }), 'investigating', 'agent', 'x');
      await repo.transition(scope(CONTEXT, { id: input.id }), 'resolved', 'human', 'pavlo');

      const found = await repo.findMostRecentlyResolvedByFingerprint(
        scope(OTHER_CONTEXT, { fingerprint: input.fingerprint }),
      );
      expect(found).toBeNull();
    }));

  it('findMostRecentlyResolvedByFingerprint picks the most recently resolved issue when a recurrence chain left more than one', () =>
    withCorrelation(newCorrelationId(), async () => {
      const fingerprint = `fp-${randomUUID()}`;
      const older = newIssue({ fingerprint });
      await repo.create(scope(CONTEXT, older));
      await repo.transition(scope(CONTEXT, { id: older.id }), 'investigating', 'agent', 'x');
      await repo.transition(scope(CONTEXT, { id: older.id }), 'resolved', 'human', 'pavlo');

      const newer = newIssue({ fingerprint, recurrenceOf: older.id });
      await repo.create(scope(CONTEXT, newer));
      await repo.transition(scope(CONTEXT, { id: newer.id }), 'investigating', 'agent', 'x');
      await repo.transition(scope(CONTEXT, { id: newer.id }), 'resolved', 'human', 'pavlo');

      const found = await repo.findMostRecentlyResolvedByFingerprint(
        scope(CONTEXT, { fingerprint }),
      );
      expect(found?.id).toBe(newer.id);
    }));

  it('create with recurrenceOf writes the recurrence_of relationship and its issue_event in the same transaction as the issue (001 T022, FR-005, FR-020)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const original = newIssue();
      await repo.create(scope(CONTEXT, original));
      // Resolved first (001 T026 review finding): the new unique partial index only allows one
      // *open* issue per fingerprint, so a recurrence sharing a fingerprint with a still-open
      // issue is exactly the state that index now correctly refuses — matching the real flow a
      // recurrence goes through (data-model.md: resolved --outside window--> new issue).
      await repo.transition(scope(CONTEXT, { id: original.id }), 'investigating', 'agent', 'x');
      await repo.transition(scope(CONTEXT, { id: original.id }), 'resolved', 'human', 'pavlo');

      const recurrence = newIssue({
        fingerprint: original.fingerprint,
        recurrenceOf: original.id,
      });
      const created = await repo.create(scope(CONTEXT, recurrence));
      expect(created.id).toBe(recurrence.id);

      const relationship = await query(
        pg,
        `select kind, rule, removed_at from "issue"."issue_relationship"
         where issue_id = '${recurrence.id}' and other_issue_id = '${original.id}'`,
      );
      expect(relationship).toBe('recurrence_of|reopen_window_exceeded|');

      const event = await query(
        pg,
        `select type from "issue"."issue_event"
         where issue_id = '${recurrence.id}' and type = 'related'`,
      );
      expect(event).toBe('related');
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

  it('create throws FingerprintAlreadyOpenError for a second open issue sharing a fingerprint (001 T026 review finding)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const fingerprint = `fp-${randomUUID()}`;
      await repo.create(scope(CONTEXT, newIssue({ fingerprint })));

      await expect(repo.create(scope(CONTEXT, newIssue({ fingerprint })))).rejects.toBeInstanceOf(
        FingerprintAlreadyOpenError,
      );
    }));

  it('create allows a second issue sharing a fingerprint once the first is resolved — the unique index is scoped to open states only', () =>
    withCorrelation(newCorrelationId(), async () => {
      const fingerprint = `fp-${randomUUID()}`;
      const first = await repo.create(scope(CONTEXT, newIssue({ fingerprint })));
      await repo.transition(scope(CONTEXT, { id: first.id }), 'investigating', 'agent', 'x');
      await repo.transition(scope(CONTEXT, { id: first.id }), 'resolved', 'human', 'pavlo');

      const second = await repo.create(
        scope(CONTEXT, newIssue({ fingerprint, recurrenceOf: first.id })),
      );
      expect(second.id).not.toBe(first.id);
    }));

  it(
    'concurrently creating the same brand-new fingerprint sixteen times over produces exactly one issue',
    () =>
      withCorrelation(newCorrelationId(), async () => {
        // The exact shape 001 T026's real load test caught: `QUEUE_CLASSES.ingestion.concurrency`
        // is 16 — this is that race, reproduced directly against the repository rather than
        // through the full HTTP → BullMQ → worker path.
        const fingerprint = `fp-${randomUUID()}`;
        const attempts = Array.from({ length: 16 }, () =>
          repo.create(scope(CONTEXT, newIssue({ fingerprint }))).catch((error) => {
            if (error instanceof FingerprintAlreadyOpenError) return null;
            throw error;
          }),
        );
        const results = await Promise.all(attempts);
        const succeeded = results.filter((result) => result !== null);
        expect(succeeded).toHaveLength(1);

        const rows = await query(
          pg,
          `select count(*) from "issue"."issue" where fingerprint = '${fingerprint}'`,
        );
        expect(rows).toBe('1');
      }),
    15_000,
  );

  it.each([
    'production_incident',
    'user_report',
    'monitoring_alert',
    'regression',
    'automated_detection',
    'knowledge_drift',
  ] as const)(
    'every issue kind enters the same pipeline: %s creates and transitions identically (001 T037, FR-001)',
    (kind) =>
      withCorrelation(newCorrelationId(), async () => {
        // The shared graph in `state-machine.ts` carries no kind-conditional edges of its own —
        // every kind creates and moves through the identical detected -> investigating -> resolved
        // path. A human-caused resolve is used here (not `agent`) so this proves the *shared*
        // mechanics without tripping T038's own, deliberately narrow exception (knowledge_drift
        // alone cannot be auto-resolved by a non-human cause, FR-001a) — a documented carve-out on
        // top of the shared pipeline, not evidence the pipeline itself is no longer shared.
        const input = newIssue({ kind });
        const created = await repo.create(scope(CONTEXT, input));
        expect(created.kind).toBe(kind);

        await repo.transition(scope(CONTEXT, { id: input.id }), 'investigating', 'agent', 'x');
        const resolved = await repo.transition(
          scope(CONTEXT, { id: input.id }),
          'resolved',
          'human',
          'pavlo',
        );
        expect(resolved.state).toBe('resolved');
        // Transitioning never touches kind — it is immutable identity, not workflow state.
        expect(resolved.kind).toBe(kind);
      }),
  );

  it('findOpenCorrelationCandidates finds a same-component, same-environment issue inside the window, and only that (001 T039, FR-020)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const checkout = randomUUID();
      const billing = randomUUID();
      const subject = await repo.create(
        scope(CONTEXT, newIssue({ componentId: checkout, environment: 'prod' })),
      );
      const withinWindow = await repo.create(
        scope(
          CONTEXT,
          newIssue({
            componentId: checkout,
            environment: 'prod',
            firstSeenAt: new Date(subject.firstSeenAt.getTime() + 60_000),
          }),
        ),
      );
      // Each excluded for a different reason: different component, different environment,
      // outside the window, and the subject's own tenant-isolated twin.
      await repo.create(scope(CONTEXT, newIssue({ componentId: billing, environment: 'prod' })));
      await repo.create(
        scope(CONTEXT, newIssue({ componentId: checkout, environment: 'staging' })),
      );
      await repo.create(
        scope(
          CONTEXT,
          newIssue({
            componentId: checkout,
            environment: 'prod',
            firstSeenAt: new Date(subject.firstSeenAt.getTime() + 2 * 60 * 60 * 1000),
          }),
        ),
      );
      await repo.create(
        scope(OTHER_CONTEXT, newIssue({ componentId: checkout, environment: 'prod' })),
      );

      const candidates = await repo.findOpenCorrelationCandidates(
        scope(CONTEXT, {
          componentId: checkout,
          environment: 'prod',
          excludeId: subject.id,
          since: new Date(subject.firstSeenAt.getTime() - 60 * 60 * 1000),
          until: new Date(subject.firstSeenAt.getTime() + 60 * 60 * 1000),
        }),
      );

      expect(candidates.map((c) => c.id)).toEqual([withinWindow.id]);
    }));

  it('correlate records a related relationship, publishes IssueRelated, and is idempotent (001 T039, FR-020)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const a = await repo.create(scope(CONTEXT, newIssue()));
      const b = await repo.create(scope(CONTEXT, newIssue()));

      const relationship = await repo.correlate(
        scope(CONTEXT, { id: a.id, otherId: b.id, rule: 'component_environment_window' }),
      );
      expect(relationship).toMatchObject({
        issueId: a.id,
        otherIssueId: b.id,
        kind: 'related',
        rule: 'component_environment_window',
      });

      const rows = await query(
        pg,
        `select kind, rule from "issue"."issue_relationship"
         where issue_id = '${a.id}' and other_issue_id = '${b.id}'`,
      );
      expect(rows).toBe('related|component_environment_window');

      // Correlating the identical pair again is a no-op, not a duplicate row or an error.
      const again = await repo.correlate(
        scope(CONTEXT, { id: a.id, otherId: b.id, rule: 'component_environment_window' }),
      );
      expect(again).toBeNull();
      const count = await query(
        pg,
        `select count(*) from "issue"."issue_relationship" where issue_id = '${a.id}' and other_issue_id = '${b.id}'`,
      );
      expect(count).toBe('1');

      // Neither issue's state changed — a `related` link is never itself a state transition.
      const subjectAfter = await repo.findById(scope(CONTEXT, { id: a.id }));
      const otherAfter = await repo.findById(scope(CONTEXT, { id: b.id }));
      expect(subjectAfter?.state).toBe('detected');
      expect(otherAfter?.state).toBe('detected');
    }));
});
