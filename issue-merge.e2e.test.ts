import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@healer/prisma-client';
import {
  ConcurrentModificationError,
  InvalidIssueTransitionError,
  InvalidMergeError,
  MergeIntegrityError,
  UnmergeFingerprintTakenError,
  PrismaIssueRepository,
  PrismaTimelineRepository,
  projectIssueRelationships,
  type Issue,
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
 * Merge and unmerge (001 T049/T050, FR-016, FR-020, R-08, quickstart 17/18). A merge is a
 * `merged_into` relationship row, a state change and an event — nothing else. Evidence is never
 * copied or moved, so there is nothing to give back on unmerge: "counts restored to both sides, not
 * split" holds because counts never move.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000c1';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000c2';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);
const REASON = 'same NPE, two providers';
const WHEN = new Date('2026-01-01T00:00:00Z');

type State = Issue['state'];
/** The transitions that reach each mergeable state from `detected`, in order. */
const PATH: Readonly<Record<string, readonly State[]>> = {
  detected: [],
  investigating: ['investigating'],
  diagnosed: ['investigating', 'diagnosed'],
  acting: ['investigating', 'diagnosed', 'acting'],
  needs_human: ['investigating', 'diagnosed', 'needs_human'],
  stale: ['stale'],
  resolved: ['resolved'],
};

describe('merge and unmerge (001 T049/T050)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaIssueRepository;
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
    repo = new PrismaIssueRepository(prisma);
    timeline = new PrismaTimelineRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(patients.map((client) => client.$disconnect()));
    await prisma?.$disconnect();
    await pg?.stop();
  });

  /** An issue in `state`, reached through the real transitions. */
  async function issueIn(
    state: keyof typeof PATH = 'detected',
    overrides: Partial<NewIssue> = {},
  ): Promise<string> {
    const id = randomUUID();
    await repo.create(
      scope(CONTEXT, {
        id,
        kind: 'production_incident',
        environment: 'prod',
        severity: 'high',
        fingerprint: `fp-${randomUUID()}`,
        rulesetVersion: 1,
        firstSeenAt: WHEN,
        lastSeenAt: WHEN,
        ...overrides,
      }),
    );
    for (const to of PATH[state]!) {
      await repo.transition(scope(CONTEXT, { id }), to, to === 'stale' ? 'system' : 'human', 'x');
    }
    return id;
  }

  const mergeResult = (id: string, intoId: string, reason = REASON) =>
    repo.merge(scope(CONTEXT, { id, intoId }), 'pavlo', reason);
  const unmergeResult = (id: string) => repo.unmerge(scope(CONTEXT, { id }), 'pavlo');
  const merge = async (id: string, intoId: string, reason = REASON) =>
    (await mergeResult(id, intoId, reason)).issue;
  const unmerge = async (id: string) => (await unmergeResult(id)).issue;
  const get = async (id: string) => (await repo.findById(scope(CONTEXT, { id })))!;

  async function addEvidence(issueId: string): Promise<string> {
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
        observedAt: WHEN,
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      },
    });
    return id;
  }

  const evidenceRows = (...ids: string[]) =>
    query(
      pg,
      `select id, issue_id, ref_state from "evidence"."evidence"
       where issue_id in (${ids.map((i) => `'${i}'`).join(',')}) order by id`,
    );
  const relationshipRows = (id: string) =>
    query(
      pg,
      `select other_issue_id, rule, removed_at is not null from "issue"."issue_relationship"
       where issue_id = '${id}' and kind = 'merged_into' order by created_at`,
    );
  const outboxNames = (id: string) =>
    query(
      pg,
      `select coalesce(string_agg(name, ',' order by name), '') from "events"."outbox"
       where subject_id = '${id}'`,
    );
  const eventCount = async (id: string, type: string) =>
    Number(
      await query(
        pg,
        `select count(*) from "issue"."issue_event" where issue_id = '${id}' and type = '${type}'`,
      ),
    );

  /**
   * A repository on its own single-connection client whose session waits five seconds before
   * running Postgres's deadlock check (default one). A deadlock is detected by whichever waiter's
   * timer fires first *with the cycle already formed*; giving the repository the long timer and the
   * outside transaction a longer one means the repository is the victim whenever the cycle forms
   * within five seconds, however loaded the machine — with the default second it was a coin flip.
   */
  const patients: PrismaClient[] = [];
  async function patientRepository() {
    const client = new PrismaClient({ datasourceUrl: `${pg.url}?connection_limit=1` });
    await client.$connect();
    await client.$executeRaw`SET deadlock_timeout = '5s'`;
    patients.push(client);
    return new PrismaIssueRepository(client);
  }

  const inScope = <T>(fn: () => Promise<T>) => withCorrelation(newCorrelationId(), fn);

  /** Settles to a value either way, so a race can be inspected instead of thrown out of. */
  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ value }) as { value: T; error?: undefined },
      (error: unknown) => ({ error }) as { value?: undefined; error: unknown },
    );

  /**
   * A transaction that runs `work` (taking whatever locks it wants) and then stays open until
   * `release()`. What makes a race deterministic: the operations under test are started while this
   * holds the lock, and the test waits until Postgres reports them blocked before letting go —
   * so "they overlapped" is observed, not hoped for.
   */
  async function hold(
    work: (tx: Prisma.TransactionClient) => Promise<void>,
    after?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    const done = prisma.$transaction(
      async (tx) => {
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
      release: async () => {
        open();
        await done;
      },
    };
  }
  const lockRows = (...ids: string[]) =>
    hold(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "issue"."issue"
        WHERE tenant_id = ${TENANT_ID}::uuid AND id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    });

  /** Waits until at least `count` backends are waiting on a lock; fails the test if they never do. */
  async function waitForBlocked(count: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const waiting = Number(
        await query(
          pg,
          `select count(*) from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`,
        ),
      );
      if (waiting >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`expected ${count} blocked backend(s), saw ${waiting} — nothing waited`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  describe('merge (T049)', () => {
    it('records a merged_into row, the merge event and the outbox events — and moves nothing else', () =>
      inScope(async () => {
        const x = await issueIn('investigating');
        const y = await issueIn('diagnosed');
        await repo.recordOccurrence(scope(CONTEXT, { id: x }), WHEN);
        await repo.recordOccurrence(scope(CONTEXT, { id: y }), WHEN);
        const [xBefore, yBefore] = [await get(x), await get(y)];

        const merged = await merge(x, y);

        expect(merged).toMatchObject({ id: x, state: 'merged' });
        expect(await relationshipRows(x)).toBe(`${y}|human|f`);
        const event = await query(
          pg,
          `select from_state, to_state, cause, actor_ref, payload->>'intoIssueId', payload->>'reason',
                  payload->>'relationshipId' = (select id::text from "issue"."issue_relationship"
                    where issue_id = '${x}' and kind = 'merged_into')
           from "issue"."issue_event" where issue_id = '${x}' and type = 'merged'`,
        );
        expect(event).toBe(`investigating|merged|human|pavlo|${y}|${REASON}|t`);
        expect(await outboxNames(x)).toBe(
          'IssueDetected,IssueMerged,IssueStateChanged,IssueStateChanged',
        );
        expect(await outboxNames(y)).not.toContain('IssueMerged');
        const projection = projectIssueRelationships(
          x,
          await repo.findRelationships(scope(CONTEXT, { id: x })),
        );
        expect(projection.mergedIntoId).toBe(y);

        // Counts, timestamps and the survivor are exactly as they were (R-08).
        expect(await get(y)).toEqual(yBefore);
        expect(merged).toEqual({ ...xBefore, state: 'merged' });
      }));

    it('does not copy or move any evidence row (FR-016, R-08, quickstart 17), on merge or on unmerge', () =>
      inScope(async () => {
        const x = await issueIn();
        const y = await issueIn();
        await addEvidence(x);
        await addEvidence(x);
        await addEvidence(y);
        const before = await evidenceRows(x, y);
        expect(before.split('\n')).toHaveLength(3);

        await merge(x, y);
        expect(await evidenceRows(x, y)).toBe(before);
        await unmerge(x);
        expect(await evidenceRows(x, y)).toBe(before);
        // Nothing was written anywhere else either: evidence for these two issues, per issue.
        expect(
          await query(pg, `select count(*) from "evidence"."evidence" where issue_id = '${y}'`),
        ).toBe('1');
      }));

    it('leaves each side’s timeline unchanged except for the merge events themselves (quickstart 17/18)', () =>
      inScope(async () => {
        const x = await issueIn('investigating');
        const y = await issueIn();
        await addEvidence(x);
        await repo.recordOccurrence(scope(CONTEXT, { id: y }), WHEN);
        const timelineOf = (id: string) => timeline.forIssue(scope(CONTEXT, { issueId: id }));
        const [xBefore, yBefore] = [await timelineOf(x), await timelineOf(y)];

        await merge(x, y);
        const xMerged = await timelineOf(x);
        expect(xMerged.filter((e) => e.type !== 'merged')).toEqual(xBefore);
        expect(xMerged.filter((e) => e.type === 'merged')).toHaveLength(1);
        expect(await timelineOf(y)).toEqual(yBefore);

        await unmerge(x);
        const xAfter = await timelineOf(x);
        expect(xAfter.filter((e) => e.type !== 'merged' && e.type !== 'unmerged')).toEqual(xBefore);
        expect(xAfter.filter((e) => e.type === 'unmerged')).toHaveLength(1);
        expect(await timelineOf(y)).toEqual(yBefore);
      }));

    it('a repeat is reported as already_merged, writes nothing, and keeps the first reason and actor', () =>
      inScope(async () => {
        const x = await issueIn();
        const y = await issueIn();
        const first = await mergeResult(x, y);

        const second = await repo.merge(
          scope(CONTEXT, { id: x, intoId: y }),
          'someone-else',
          'a different reason this time',
        );

        expect([first.outcome, second.outcome]).toEqual(['merged', 'already_merged']);
        expect(second.issue).toEqual(first.issue);
        expect(await relationshipRows(x)).toBe(`${y}|human|f`);
        expect(await eventCount(x, 'merged')).toBe(1);
        expect(
          await query(
            pg,
            `select actor_ref, payload->>'reason' from "issue"."issue_event"
             where issue_id = '${x}' and type = 'merged'`,
          ),
        ).toBe(`pavlo|${REASON}`);
        expect(await outboxNames(x)).toBe('IssueDetected,IssueMerged,IssueStateChanged');
      }));

    it('a repeat is not a success once the source was removed, or the target was', () =>
      inScope(async () => {
        const [x, y, a, b] = [await issueIn(), await issueIn(), await issueIn(), await issueIn()];
        await merge(x, y);
        await repo.transition(scope(CONTEXT, { id: x }), 'removed', 'human', 'x');
        // The source is removed, its row still live: not "already merged".
        await expect(mergeResult(x, y)).rejects.toBeInstanceOf(InvalidIssueTransitionError);

        await merge(a, b);
        await repo.transition(scope(CONTEXT, { id: b }), 'removed', 'human', 'x');
        // The repeat re-checks the target.
        await expect(mergeResult(a, b)).rejects.toBeInstanceOf(InvalidMergeError);
      }));

    it('a merged issue that is later removed does not pin its target: the target can still be merged (T049 review)', () =>
      inScope(async () => {
        const [x, y, z] = [await issueIn(), await issueIn(), await issueIn()];
        await merge(x, y);
        await repo.transition(scope(CONTEXT, { id: x }), 'removed', 'human', 'x');

        // x's row is still live (the invariant allows merged -> removed), but a removed issue is
        // not "an issue merged into y" any more.
        await expect(merge(y, z)).resolves.toMatchObject({ id: y, state: 'merged' });
        // And unmerging the removed x is a typed refusal, not an opaque failure.
        await expect(unmerge(x)).rejects.toBeInstanceOf(InvalidIssueTransitionError);
        expect(await get(x)).toMatchObject({ state: 'removed' });
      }));

    it('ids are case-insensitive: an upper-case id is the same issue, not a second one', () =>
      inScope(async () => {
        const [x, y] = [await issueIn(), await issueIn()];
        await expect(merge(x, x.toUpperCase())).rejects.toBeInstanceOf(InvalidMergeError);

        await expect(merge(x.toUpperCase(), y.toUpperCase())).resolves.toMatchObject({
          id: x,
          state: 'merged',
        });
        expect(await relationshipRows(x)).toBe(`${y}|human|f`);
        await expect(unmerge(x.toUpperCase())).resolves.toMatchObject({ id: x, state: 'detected' });
      }));

    it('refuses to merge an already merged issue into a different one', () =>
      inScope(async () => {
        const [x, y, z] = [await issueIn(), await issueIn(), await issueIn()];
        await merge(x, y);

        await expect(merge(x, z)).rejects.toBeInstanceOf(InvalidMergeError);

        expect(await relationshipRows(x)).toBe(`${y}|human|f`);
      }));

    it('refuses to merge an issue into itself', () =>
      inScope(async () => {
        const x = await issueIn();
        await expect(merge(x, x)).rejects.toBeInstanceOf(InvalidMergeError);
        expect(await get(x)).toMatchObject({ state: 'detected' });
        expect(await relationshipRows(x)).toBe('');
      }));

    it('refuses to merge into an issue that is itself merged — no chains', () =>
      inScope(async () => {
        const [x, s, t] = [await issueIn(), await issueIn(), await issueIn()];
        await merge(s, t);

        await expect(merge(x, s)).rejects.toBeInstanceOf(InvalidMergeError);

        expect(await get(x)).toMatchObject({ state: 'detected' });
        expect(await relationshipRows(x)).toBe('');
      }));

    it('refuses a removed target, a removed source, and a blank reason', () =>
      inScope(async () => {
        const [x, gone] = [await issueIn(), await issueIn()];
        await repo.transition(scope(CONTEXT, { id: gone }), 'removed', 'human', 'x');

        await expect(merge(x, gone)).rejects.toBeInstanceOf(InvalidMergeError);
        await expect(merge(gone, x)).rejects.toBeInstanceOf(InvalidIssueTransitionError);
        await expect(merge(x, await issueIn(), '  ')).rejects.toBeInstanceOf(InvalidMergeError);
        expect(await get(x)).toMatchObject({ state: 'detected' });
      }));

    it('refuses to merge an issue that other issues are merged into, or a chain would form', () =>
      inScope(async () => {
        const [x, y, z] = [await issueIn(), await issueIn(), await issueIn()];
        await merge(x, y);

        await expect(merge(y, z)).rejects.toBeInstanceOf(InvalidMergeError);

        expect(await get(y)).toMatchObject({ state: 'detected' });
        // Once x is unmerged, y is free to be merged.
        await unmerge(x);
        await expect(merge(y, z)).resolves.toMatchObject({ state: 'merged' });
      }));

    it('a plain transition can never produce a merged issue with no relationship row', () =>
      inScope(async () => {
        const x = await issueIn();
        await expect(
          repo.transition(scope(CONTEXT, { id: x }), 'merged', 'human', 'pavlo'),
        ).rejects.toBeInstanceOf(InvalidIssueTransitionError);
        expect(await get(x)).toMatchObject({ state: 'detected' });
      }));

    it('another tenant’s issue — as source or as target — is indistinguishable from one that does not exist', () =>
      inScope(async () => {
        const x = await issueIn();
        const y = await issueIn();
        const theirs = randomUUID();
        await repo.create(
          scope(OTHER_CONTEXT, {
            id: theirs,
            kind: 'production_incident',
            environment: 'prod',
            severity: 'high',
            fingerprint: `fp-${theirs}`,
            rulesetVersion: 1,
            firstSeenAt: WHEN,
            lastSeenAt: WHEN,
          }),
        );

        const outcomes = await Promise.allSettled([
          merge(x, theirs),
          merge(x, randomUUID()),
          merge(x, 'not-a-uuid'),
          repo.merge(scope(OTHER_CONTEXT, { id: y, intoId: theirs }), 'pavlo', REASON),
          repo.merge(scope(CONTEXT, { id: theirs, intoId: y }), 'pavlo', REASON),
        ]);

        for (const outcome of outcomes) {
          expect(outcome.status).toBe('rejected');
          const reason = (outcome as PromiseRejectedResult).reason;
          expect(reason).toBeInstanceOf(NotFoundError);
          expect(reason.message).toBe('Issue not found');
        }
        expect(await get(x)).toMatchObject({ state: 'detected' });
        expect(await get(y)).toMatchObject({ state: 'detected' });
        expect(await repo.findById(scope(OTHER_CONTEXT, { id: theirs }))).toMatchObject({
          state: 'detected',
        });
      }));

    it('takes the merged issue out of fingerprint matching and the staleness sweep, and gives its slot up', () =>
      inScope(async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const x = await issueIn('detected', { fingerprint });
        const y = await issueIn();
        const idleBefore = new Date('2100-01-01T00:00:00Z');
        const candidates = async () =>
          (await repo.findStaleCandidates(scope(CONTEXT, { idleBefore }))).map((c) => c.id);
        expect(await candidates()).toContain(x);

        await merge(x, y);

        expect(await repo.findOpenByFingerprint(scope(CONTEXT, { fingerprint }))).toBeNull();
        expect(await candidates()).not.toContain(x);
        expect(await candidates()).toContain(y);
        // The fingerprint's open slot is free: a later signal with it opens a fresh issue.
        await expect(issueIn('detected', { fingerprint })).resolves.toBeDefined();
      }));
  });

  describe('unmerge (T050)', () => {
    it.each(Object.keys(PATH))(
      'restores an issue that was %s to exactly that state, with its timestamps',
      (state) =>
        inScope(async () => {
          const x = await issueIn(state);
          const y = await issueIn();
          const before = await get(x);

          await merge(x, y);
          const restored = await unmerge(x);

          expect(restored).toEqual(before);
          expect(restored.state).toBe(state);
          const projection = projectIssueRelationships(
            x,
            await repo.findRelationships(scope(CONTEXT, { id: x })),
          );
          expect(projection.mergedIntoId).toBeNull();
        }),
    );

    it('sets removed_at (keeping the row), writes the unmerged event and publishes IssueUnmerged', () =>
      inScope(async () => {
        const x = await issueIn('investigating');
        const y = await issueIn();
        await merge(x, y);

        await unmerge(x);

        expect(await relationshipRows(x)).toBe(`${y}|human|t`);
        expect(
          await query(
            pg,
            `select from_state, to_state, cause, actor_ref, payload->>'intoIssueId'
             from "issue"."issue_event" where issue_id = '${x}' and type = 'unmerged'`,
          ),
        ).toBe(`merged|investigating|human|pavlo|${y}`);
        expect(await outboxNames(x)).toBe(
          'IssueDetected,IssueMerged,IssueStateChanged,IssueStateChanged,IssueStateChanged,IssueUnmerged',
        );
      }));

    it('counts on both sides are what they were, never split (R-08)', () =>
      inScope(async () => {
        const x = await issueIn();
        const y = await issueIn();
        for (const id of [x, x, y]) await repo.recordOccurrence(scope(CONTEXT, { id }), WHEN);
        expect([(await get(x)).occurrenceCount, (await get(y)).occurrenceCount]).toEqual([3n, 2n]);

        await merge(x, y);
        await unmerge(x);

        expect([(await get(x)).occurrenceCount, (await get(y)).occurrenceCount]).toEqual([3n, 2n]);
      }));

    it('is idempotent and says so: a repeat, or an issue never merged, is not_merged and writes nothing', () =>
      inScope(async () => {
        const x = await issueIn('diagnosed');
        const y = await issueIn();
        const never = await unmergeResult(y);
        expect(never).toMatchObject({ outcome: 'not_merged', issue: { state: 'detected' } });
        expect(await eventCount(y, 'unmerged')).toBe(0);

        await merge(x, y);
        const first = await unmergeResult(x);
        const second = await unmergeResult(x);

        expect([first.outcome, second.outcome]).toEqual(['unmerged', 'not_merged']);
        expect(second.issue).toEqual(first.issue);
        expect(await eventCount(x, 'unmerged')).toBe(1);
        expect(await relationshipRows(x)).toBe(`${y}|human|t`);
      }));

    it('can merge again after an unmerge: a new row, the old one kept as history — and restores from the right merge', () =>
      inScope(async () => {
        const [x, y, z] = [await issueIn(), await issueIn(), await issueIn()];
        await merge(x, y);
        await unmerge(x);
        // The first merge left `detected`; the second leaves `investigating`.
        await repo.transition(scope(CONTEXT, { id: x }), 'investigating', 'agent', 'investigator');

        await merge(x, z);

        expect(await relationshipRows(x)).toBe(`${y}|human|t\n${z}|human|f`);
        expect(await unmerge(x)).toMatchObject({ state: 'investigating' });
      }));

    it('another tenant’s issue is not found', () =>
      inScope(async () => {
        const x = await issueIn();
        const y = await issueIn();
        await merge(x, y);

        await expect(repo.unmerge(scope(OTHER_CONTEXT, { id: x }), 'pavlo')).rejects.toBeInstanceOf(
          NotFoundError,
        );
        await expect(unmerge(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
        expect(await get(x)).toMatchObject({ state: 'merged' });
      }));

    it('refuses, and stays merged, when an open issue has since taken the fingerprint', () =>
      inScope(async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const x = await issueIn('investigating', { fingerprint });
        const y = await issueIn();
        await merge(x, y);
        const usurper = await issueIn('detected', { fingerprint });

        const refusal = await unmerge(x).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(UnmergeFingerprintTakenError);
        // The real fingerprint, not an issue id — and not the class ingestion reads as "attach".
        expect(refusal).toMatchObject({ issueId: x, fingerprint, restoreTo: 'investigating' });
        expect((refusal as Error).message).toContain(fingerprint);
        expect((refusal as Error).name).not.toBe('FingerprintAlreadyOpenError');

        expect(await get(x)).toMatchObject({ state: 'merged' });
        expect(await relationshipRows(x)).toBe(`${y}|human|f`);
        expect(await eventCount(x, 'unmerged')).toBe(0);
        // Resolve the other one and it goes through.
        await repo.transition(scope(CONTEXT, { id: usurper }), 'resolved', 'human', 'x');
        await expect(unmerge(x)).resolves.toMatchObject({ state: 'investigating' });
      }));

    it('a resolved issue unmerges beside an open one with its fingerprint — a recurrence is legal', () =>
      inScope(async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const x = await issueIn('resolved', { fingerprint });
        const y = await issueIn();
        await merge(x, y);
        await issueIn('detected', { fingerprint });

        await expect(unmerge(x)).resolves.toMatchObject({ state: 'resolved' });
      }));

    describe('integrity failures fail closed, typed, and are told apart', () => {
      const integrity = (id: string) => unmerge(id).catch((error: unknown) => error);
      const handMerge = (x: string, y: string) =>
        query(
          pg,
          `begin;
           update "issue"."issue" set state = 'merged' where id = '${x}';
           insert into "issue"."issue_relationship" (id, tenant_id, issue_id, other_issue_id, kind, rule)
             values ('${randomUUID()}', '${TENANT_ID}', '${x}', '${y}', 'merged_into', 'human');
           commit;`,
        );

      it('merge_record_missing: a row made by hand has no merge event to restore from', () =>
        inScope(async () => {
          const x = await issueIn('investigating');
          const y = await issueIn();
          await handMerge(x, y);

          const error = await integrity(x);

          expect(error).toBeInstanceOf(MergeIntegrityError);
          expect(error).toMatchObject({ reason: 'merge_record_missing', issueId: x });
          expect(await get(x)).toMatchObject({ state: 'merged' });
          expect(await relationshipRows(x)).toBe(`${y}|human|f`);
          expect(await eventCount(x, 'unmerged')).toBe(0);
        }));

      it('merge_record_missing: an OLDER merge event is not a substitute for the live row’s own', () =>
        inScope(async () => {
          const x = await issueIn('investigating');
          const [y, z] = [await issueIn(), await issueIn()];
          await merge(x, y);
          await unmerge(x);
          expect(await eventCount(x, 'merged')).toBe(1); // the older one, from the first row
          await handMerge(x, z);

          const error = await integrity(x);

          expect(error).toMatchObject({ reason: 'merge_record_missing' });
          expect(await get(x)).toMatchObject({ state: 'merged' });
          expect(await eventCount(x, 'unmerged')).toBe(1); // only the earlier, legitimate one
        }));

      it('merged_without_relationship: merged with no live row (which the database normally refuses)', () =>
        inScope(async () => {
          const x = await issueIn('investigating');
          await query(
            pg,
            `set session_replication_role = replica;
             update "issue"."issue" set state = 'merged' where id = '${x}';`,
          );

          const error = await integrity(x);

          expect(error).toBeInstanceOf(MergeIntegrityError);
          expect(error).toMatchObject({ reason: 'merged_without_relationship' });
        }));

      it('relationship_vanished: the row is withdrawn by someone else while the unmerge holds the issue', () =>
        inScope(async () => {
          const [x, y] = [await issueIn('investigating'), await issueIn()];
          await merge(x, y);
          // A writer that skips both the repository and the deferred check, and locks only the
          // relationship row — the unmerge reads it live, then finds it gone when it gets there.
          const rogue = await hold(async (tx) => {
            await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
            await tx.$executeRaw`UPDATE "issue"."issue_relationship" SET removed_at = now()
              WHERE issue_id = ${x}::uuid AND kind = 'merged_into'`;
          });
          const unmerging = settle(unmerge(x));
          await waitForBlocked(1);
          await rogue.release();

          const { error } = await unmerging;

          expect(error).toBeInstanceOf(MergeIntegrityError);
          expect(error).toMatchObject({ reason: 'relationship_vanished' });
          expect(await eventCount(x, 'unmerged')).toBe(0);
        }));
    });

    it('a merged issue can still be removed, and then can no longer be unmerged', () =>
      inScope(async () => {
        const x = await issueIn();
        const y = await issueIn();
        await merge(x, y);
        await repo.transition(scope(CONTEXT, { id: x }), 'removed', 'human', 'x');

        await expect(unmerge(x)).rejects.toBeInstanceOf(InvalidIssueTransitionError);
      }));
  });

  describe('concurrency — every race is forced by a held-open transaction, not left to timing', () => {
    it('overlapping merges of one issue into different targets: exactly one wins', () =>
      inScope(async () => {
        const [x, y, z] = [await issueIn(), await issueIn(), await issueIn()];
        const holder = await lockRows(x);
        const a = settle(merge(x, y));
        const b = settle(merge(x, z));
        await waitForBlocked(2); // both are inside the merge, waiting on x
        await holder.release();

        const outcomes = await Promise.all([a, b]);

        expect(outcomes.filter((o) => o.error === undefined)).toHaveLength(1);
        expect(outcomes.find((o) => o.error !== undefined)!.error).toBeInstanceOf(
          InvalidMergeError,
        );
        expect((await relationshipRows(x)).split('\n')).toHaveLength(1);
        expect(await eventCount(x, 'merged')).toBe(1);
      }));

    it('x into y racing y into z: exactly one wins, never a chain', () =>
      inScope(async () => {
        const [x, y, z] = [await issueIn(), await issueIn(), await issueIn()];
        const holder = await lockRows(y);
        const a = settle(merge(x, y));
        const b = settle(merge(y, z));
        await waitForBlocked(2); // both need y
        await holder.release();

        const outcomes = await Promise.all([a, b]);

        expect(outcomes.filter((o) => o.error === undefined)).toHaveLength(1);
        expect(outcomes.find((o) => o.error !== undefined)!.error).toBeInstanceOf(
          InvalidMergeError,
        );
        expect(
          await query(
            pg,
            `select count(*) from "issue"."issue_relationship"
             where kind = 'merged_into' and removed_at is null
               and issue_id in ('${x}', '${y}', '${z}')`,
          ),
        ).toBe('1');
      }));

    it('locks the pair in id order: a merge holding the lower id blocks anyone wanting it while it waits for the higher', () =>
      inScope(async () => {
        const [lo, hi] = [randomUUID(), randomUUID()].sort() as [string, string];
        // Physical order is the opposite of id order, so a lock taken in scan order would take
        // `hi` first and this test would see `lo` still free.
        await issueIn('detected', { id: hi });
        await issueIn('detected', { id: lo });
        const holder = await lockRows(hi);
        const merging = settle(merge(lo, hi));
        await waitForBlocked(1); // the merge has `lo` and is waiting for `hi`

        const probe = await prisma
          .$transaction(
            (tx) =>
              tx.$queryRaw`SELECT id FROM "issue"."issue" WHERE id = ${lo}::uuid FOR UPDATE NOWAIT`,
          )
          .catch((error: unknown) => error);

        expect(probe).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((probe as Prisma.PrismaClientKnownRequestError).meta).toMatchObject({
          code: '55P03', // lock_not_available: `lo` really is held by the waiting merge
        });
        await holder.release();
        expect((await merging).error).toBeUndefined();
      }));

    it('a deadlock with an outside transaction surfaces as ConcurrentModificationError, not an opaque database error', () =>
      inScope(async () => {
        const [lo, hi] = [randomUUID(), randomUUID()].sort() as [string, string];
        await issueIn('detected', { id: hi });
        await issueIn('detected', { id: lo });
        const patient = await patientRepository();
        // The outside transaction holds `hi`, and — once released — reaches for `lo`, which the
        // merge is holding while it waits for `hi`. Its own deadlock check is set far out, and the
        // merge's (five seconds, see `patientRepository`) fires first: the merge is the victim.
        const outsider = await hold(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL deadlock_timeout = '60s'`;
            await tx.$queryRaw`SELECT id FROM "issue"."issue" WHERE id = ${hi}::uuid FOR UPDATE`;
          },
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "issue"."issue" WHERE id = ${lo}::uuid FOR UPDATE`;
          },
        );
        const merging = settle(
          patient.merge(scope(CONTEXT, { id: lo, intoId: hi }), 'pavlo', REASON),
        );
        await waitForBlocked(1);
        await outsider.release();

        const { error } = await merging;

        expect(error).toBeInstanceOf(ConcurrentModificationError);
        expect(await get(lo)).toMatchObject({ state: 'detected' });
      }));

    it('the same for an unmerge caught in a deadlock', () =>
      inScope(async () => {
        const [x, y] = [await issueIn('investigating'), await issueIn()];
        await merge(x, y);
        const patient = await patientRepository();
        // The outside transaction holds the relationship row the unmerge needs to withdraw, and —
        // once released — reaches for the issue row the unmerge already holds.
        const outsider = await hold(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL deadlock_timeout = '60s'`;
            await tx.$queryRaw`SELECT id FROM "issue"."issue_relationship"
              WHERE issue_id = ${x}::uuid AND kind = 'merged_into' FOR UPDATE`;
          },
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "issue"."issue" WHERE id = ${x}::uuid FOR UPDATE`;
          },
        );
        const unmerging = settle(patient.unmerge(scope(CONTEXT, { id: x }), 'pavlo'));
        await waitForBlocked(1);
        await outsider.release();

        const { error } = await unmerging;

        expect(error).toBeInstanceOf(ConcurrentModificationError);
        expect(await get(x)).toMatchObject({ state: 'merged' });
        expect(await eventCount(x, 'unmerged')).toBe(0);
      }));

    it('a merge waits for a state change that is mid-commit, and records the state it actually left', () =>
      inScope(async () => {
        const x = await issueIn('detected');
        const y = await issueIn();

        // What `transition` does — take the row lock with an UPDATE, write the event — held open.
        const transitioning = await hold(async (tx) => {
          await tx.$executeRaw`
            UPDATE "issue"."issue" SET state = 'investigating'::"issue"."issue_state"
            WHERE id = ${x}::uuid AND tenant_id = ${TENANT_ID}::uuid`;
          await tx.issueEvent.create({
            data: {
              id: randomUUID(),
              tenantId: TENANT_ID,
              issueId: x,
              type: 'state_changed',
              fromState: 'detected',
              toState: 'investigating',
              cause: 'agent',
              actorRef: 'investigator',
              payload: {},
              observedAt: WHEN,
            },
          });
        });

        let settled = false;
        const merging = merge(x, y).finally(() => (settled = true));
        await waitForBlocked(1);
        expect(settled).toBe(false);
        await transitioning.release();
        await merging;

        // Read after the lock: the merge left `investigating`, not the `detected` it first saw.
        expect(
          await query(
            pg,
            `select from_state from "issue"."issue_event" where issue_id = '${x}' and type = 'merged'`,
          ),
        ).toBe('investigating');
        expect(await unmerge(x)).toMatchObject({ state: 'investigating' });
      }));

    it('a merge that commits while a transition has already validated makes that transition fail, not overwrite it', () =>
      inScope(async () => {
        const [x, y] = [await issueIn(), await issueIn()];
        const holder = await lockRows(x);
        const merging = settle(merge(x, y));
        await waitForBlocked(1); // the merge is first in the queue for x
        // The transition reads x as `detected`, validates, and then queues its UPDATE behind the merge.
        const transitioning = settle(
          repo.transition(scope(CONTEXT, { id: x }), 'investigating', 'agent', 'investigator'),
        );
        await waitForBlocked(2);
        await holder.release();

        const [merged, transitioned] = await Promise.all([merging, transitioning]);

        expect(merged.error).toBeUndefined();
        expect(transitioned.error).toBeInstanceOf(ConcurrentModificationError);
        expect(await get(x)).toMatchObject({ state: 'merged' });
        expect(await eventCount(x, 'state_changed')).toBe(0);
      }));

    it('two unmerges of one issue: one unmerges, the other finds nothing to do', () =>
      inScope(async () => {
        const [x, y] = [await issueIn('investigating'), await issueIn()];
        await merge(x, y);
        const holder = await lockRows(x);
        const a = settle(unmergeResult(x));
        const b = settle(unmergeResult(x));
        await waitForBlocked(2);
        await holder.release();

        const outcomes = (await Promise.all([a, b])).map((o) => o.value?.outcome).sort();

        expect(outcomes).toEqual(['not_merged', 'unmerged']);
        expect(await eventCount(x, 'unmerged')).toBe(1);
        expect(await get(x)).toMatchObject({ state: 'investigating' });
      }));

    it('fails before taking any lock when called outside a correlated scope', async () => {
      const [x, y] = await inScope(async () => [await issueIn(), await issueIn()] as const);
      const holder = await lockRows(x);
      // If it queued for the lock first, these would hang until the holder let go.
      const quickly = <T>(promise: Promise<T>) =>
        Promise.race([
          promise.then(
            () => 'resolved',
            (error: Error) => error.message,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
        ]);

      const merged = await quickly(mergeResult(x, y));
      const unmerged = await quickly(unmergeResult(x));
      await holder.release();

      expect(merged).toMatch(/correlated scope/);
      expect(unmerged).toMatch(/correlated scope/);
      expect(await get(x)).toMatchObject({ state: 'detected' });
    });
  });

  describe('the database refuses a state and a relationship that disagree (T049)', () => {
    /**
     * Runs `sql` in one transaction through psql at verbose verbosity, and returns what it says —
     * the SQLSTATE and the trigger's own message, so an assertion cannot pass on an unrelated
     * error that merely mentions `merged_into` (an enum error, psql echoing the statement).
     */
    async function refusal(sql: string): Promise<string> {
      const result = await pg.container.exec([
        'psql',
        '-tAX',
        '-v',
        'VERBOSITY=verbose',
        '-U',
        'healer',
        '-d',
        'healer',
        '-c',
        `begin; ${sql} commit;`,
      ]);
      expect(result.exitCode).not.toBe(0);
      return result.output;
    }
    const INVARIANT_A =
      /ERROR: +23514: issue \S+ is merged but has no live merged_into relationship/;
    const INVARIANT_B =
      /ERROR: +23514: issue \S+ has a live merged_into relationship but is \w+, not merged/;
    const link = (x: string, y: string, kind = 'merged_into') =>
      `insert into "issue"."issue_relationship" (id, tenant_id, issue_id, other_issue_id, kind, rule)
       values ('${randomUUID()}', '${TENANT_ID}', '${x}', '${y}', '${kind}', 'human');`;

    it('A: state = merged with no live row (UPDATE)', () =>
      inScope(async () => {
        const x = await issueIn();
        expect(
          await refusal(`update "issue"."issue" set state = 'merged' where id = '${x}';`),
        ).toMatch(INVARIANT_A);
        expect(await get(x)).toMatchObject({ state: 'detected' });
      }));

    it('A: an issue inserted already merged, with no live row (INSERT)', async () => {
      const output = await refusal(
        `insert into "issue"."issue"
           (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version, first_seen_at, last_seen_at)
         values ('${randomUUID()}', '${TENANT_ID}', 'production_incident', 'prod', 'high', 'merged',
                 'fp-${randomUUID()}', 1, now(), now());`,
      );
      expect(output).toMatch(INVARIANT_A);
    });

    it('A: withdrawing the row while the issue is still merged (UPDATE of the row)', () =>
      inScope(async () => {
        const [x, y] = [await issueIn(), await issueIn()];
        await merge(x, y);
        expect(
          await refusal(
            `update "issue"."issue_relationship" set removed_at = now()
             where issue_id = '${x}' and kind = 'merged_into';`,
          ),
        ).toMatch(INVARIANT_A);
      }));

    it('A: deleting the row while the issue is still merged (DELETE of the row)', () =>
      inScope(async () => {
        const [x, y] = [await issueIn(), await issueIn()];
        await merge(x, y);
        expect(
          await refusal(
            `delete from "issue"."issue_relationship" where issue_id = '${x}' and kind = 'merged_into';`,
          ),
        ).toMatch(INVARIANT_A);
        expect(await relationshipRows(x)).toBe(`${y}|human|f`);
      }));

    it('B: a live row on an issue that is not merged (INSERT of the row)', () =>
      inScope(async () => {
        const [x, y] = [await issueIn(), await issueIn()];
        expect(await refusal(link(x, y))).toMatch(INVARIANT_B);
      }));

    it('B: leaving a merged issue’s state while its row is still live (UPDATE of the issue)', () =>
      inScope(async () => {
        const [x, y] = [await issueIn(), await issueIn()];
        await merge(x, y);
        expect(
          await refusal(`update "issue"."issue" set state = 'investigating' where id = '${x}';`),
        ).toMatch(INVARIANT_B);
        expect(await get(x)).toMatchObject({ state: 'merged' });
      }));

    it('a self-referential relationship of any kind is refused by the CHECK', () =>
      inScope(async () => {
        const x = await issueIn();
        expect(await refusal(link(x, x, 'related'))).toMatch(
          /ERROR: +23514: .*issue_relationship_not_self/,
        );
      }));

    it('what it allows: a merged issue being removed while its row stays live', () =>
      inScope(async () => {
        const [x, y] = [await issueIn(), await issueIn()];
        await merge(x, y);
        await query(
          pg,
          `begin; update "issue"."issue" set state = 'removed' where id = '${x}'; commit;`,
        );
        expect(await get(x)).toMatchObject({ state: 'removed' });
      }));
  });
});

describe('migration 20260928120000 refuses to run over rows the invariant forbids (T049 review)', () => {
  const NAME = '20260928120000_merged_state_invariant';
  let pg: StartedPostgres;

  const issueRow = (id: string, state: string) =>
    `insert into "issue"."issue"
       (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version, first_seen_at, last_seen_at)
     values ('${id}', '${TENANT_ID}', 'production_incident', 'prod', 'high', '${state}',
             'fp-${randomUUID()}', 1, now(), now());`;

  /** Two issues, the first in `state`, optionally with a live merged_into row. */
  async function seed(state: string, withLiveRow: boolean): Promise<string> {
    const [issueId, otherId] = [randomUUID(), randomUUID()];
    await query(
      pg,
      `${issueRow(issueId, state)} ${issueRow(otherId, 'detected')}
       ${
         withLiveRow
           ? `insert into "issue"."issue_relationship" (id, tenant_id, issue_id, other_issue_id, kind, rule)
              values ('${randomUUID()}', '${TENANT_ID}', '${issueId}', '${otherId}', 'merged_into', 'human');`
           : ''
       }`,
    );
    return issueId;
  }

  /** A fresh database at the schema this migration found. */
  async function freshDatabase(): Promise<void> {
    pg = await startPostgres();
    for (const name of migrationNames().filter((n) => n < NAME)) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`,
    );
  }

  const apply = () => applySqlFile(pg, `${MIGRATIONS_DIR}${NAME}/migration.sql`);
  const triggers = () =>
    query(pg, `select count(*) from pg_trigger where tgname like 'issue_%merged_state%'`);

  it('names a merged issue with no live row, changes nothing, and installs nothing', async () => {
    await freshDatabase();
    try {
      // What `transition(x, 'merged')` used to write: the state and no relationship at all.
      const orphan = await seed('merged', false);

      await expect(apply()).rejects.toThrow(/merged_state_invariant.*no live merged_into/s);

      expect(await triggers()).toBe('0');
      expect(await query(pg, `select state from "issue"."issue" where id = '${orphan}'`)).toBe(
        'merged',
      );
    } finally {
      await pg.stop();
    }
  }, 180_000);

  it('names a live row on an issue that is not merged', async () => {
    await freshDatabase();
    try {
      await seed('investigating', true);
      await expect(apply()).rejects.toThrow(/merged_state_invariant.*live merged_into row/s);
      expect(await triggers()).toBe('0');
    } finally {
      await pg.stop();
    }
  }, 180_000);

  it('applies over consistent data: a merged issue with its row, and issues with none', async () => {
    await freshDatabase();
    try {
      await seed('merged', true);
      await apply();
      expect(await triggers()).toBe('3');
      // NOT VALID then VALIDATEd: the constraint is enforced *and* has checked the existing rows.
      expect(
        await query(
          pg,
          `select convalidated from pg_constraint where conname = 'issue_relationship_not_self'`,
        ),
      ).toBe('t');
    } finally {
      await pg.stop();
    }
  }, 180_000);
});
