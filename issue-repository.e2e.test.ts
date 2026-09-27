import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { PrismaIssueRepository, type NewIssue } from '@healer/domain-issues';
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

  it('recordOccurrence increments occurrenceCount and advances lastSeenAt, and records a signal_received event', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newIssue({ lastSeenAt: new Date('2026-01-01T00:00:00Z') });
      await repo.create(scope(CONTEXT, input));

      const later = new Date('2026-01-02T00:00:00Z');
      const attached = await repo.recordOccurrence(scope(CONTEXT, { id: input.id }), later);
      expect(attached.occurrenceCount).toBe(2n);
      expect(attached.lastSeenAt).toEqual(later);

      const events = await query(
        pg,
        `select type, cause from "issue"."issue_event" where issue_id = '${input.id}'`,
      );
      expect(events).toBe('signal_received|ingestion');
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
