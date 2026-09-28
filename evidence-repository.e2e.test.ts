import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  assertHasEvidence,
  PrismaEvidenceLinkRepository,
  PrismaEvidenceRepository,
  recordEvidence,
  type NewEvidence,
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
 * The first real `@prisma/client` consumer in the repo (001 T006, ADR 0013) — everything before
 * this proved the database's own rules through raw SQL; this proves the repository built on top
 * of them: write and read only, tenant scoping through the query itself (not a post-fetch check),
 * and `ref_state` moving `linked -> detached` through the one narrow method that exists for it.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000a1';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000a2';
const ISSUE_ID = '00000000-0000-0000-8000-0000000000b1';

const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);

function newEvidence(overrides: Partial<NewEvidence> = {}): NewEvidence {
  return {
    id: randomUUID(),
    issueId: ISSUE_ID,
    type: 'error_signature',
    sourceSystem: 'loki',
    sourceRef: 'ref1',
    sourceLabel: 'from logs',
    excerpt: 'a captured excerpt',
    excerptTruncated: false,
    payload: { exceptionType: 'TypeError' },
    producedByStep: 'collector',
    observedAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  };
}

describe('PrismaEvidenceRepository (001 T006, FR-010, R-03)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaEvidenceRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`,
    );
    await query(
      pg,
      `insert into "issue"."issue"
         (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
          occurrence_count, first_seen_at, last_seen_at)
       values ('${ISSUE_ID}', '${TENANT_ID}', 'production_incident', 'prod', 'high', 'detected',
               'fp1', 1, 1, now(), now())`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    repo = new PrismaEvidenceRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('records evidence and reads it back for the owning tenant', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newEvidence();
      const recorded = await repo.record(scope(CONTEXT, input));
      expect(recorded).toMatchObject({
        id: input.id,
        tenantId: TENANT_ID,
        issueId: ISSUE_ID,
        excerpt: 'a captured excerpt',
        excerptTruncated: false,
        refState: 'linked',
      });

      const found = await repo.findById(scope(CONTEXT, { id: input.id }));
      expect(found).toMatchObject({ id: input.id, sourceLabel: 'from logs' });
    }));

  it('never returns another tenant’s evidence — the query itself is tenant-scoped, not a post-fetch check', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newEvidence();
      await repo.record(scope(CONTEXT, input));

      const foundByOtherTenant = await repo.findById(scope(OTHER_CONTEXT, { id: input.id }));
      expect(foundByOtherTenant).toBeNull();
    }));

  it('returns null for an id that does not exist at all', async () => {
    const found = await repo.findById(scope(CONTEXT, { id: randomUUID() }));
    expect(found).toBeNull();
  });

  it('detach moves ref_state linked -> detached and nothing else changes', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newEvidence();
      await repo.record(scope(CONTEXT, input));

      const detached = await repo.detach(scope(CONTEXT, { id: input.id }));
      expect(detached).toMatchObject({
        id: input.id,
        refState: 'detached',
        excerpt: input.excerpt,
        sourceLabel: input.sourceLabel,
      });

      const found = await repo.findById(scope(CONTEXT, { id: input.id }));
      expect(found?.refState).toBe('detached');
    }));

  it('detaching twice is idempotent: the record comes back both times and EvidenceDetached is published once (001 T052)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newEvidence();
      await repo.record(scope(CONTEXT, input));

      // Two overlapping retention runs, or one retried: the second must be a no-op, not a second
      // event for consumers to dedupe ("jobs may run twice" — AGENTS.md).
      await repo.detach(scope(CONTEXT, { id: input.id }));
      const again = await repo.detach(scope(CONTEXT, { id: input.id }));

      expect(again).toMatchObject({ id: input.id, refState: 'detached' });
      expect(
        await query(
          pg,
          `select count(*) from "events"."outbox"
           where name = 'EvidenceDetached' and payload->>'evidenceId' = '${input.id}'`,
        ),
      ).toBe('1');
    }));

  it('detach throws NotFoundError rather than leaking whether another tenant’s row exists', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newEvidence();
      await repo.record(scope(CONTEXT, input));

      await expect(repo.detach(scope(OTHER_CONTEXT, { id: input.id }))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }));

  it('rejects recording evidence against another tenant’s issue — the composite FK, not application discipline (FR-048)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newEvidence({ issueId: ISSUE_ID });
      await expect(repo.record(scope(OTHER_CONTEXT, input))).rejects.toThrow();
    }));

  it('detaching evidence leaves every conclusion built on it intact (001 T029, R-04, quickstart 12)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newEvidence();
      await repo.record(scope(CONTEXT, input));

      const linkRepo = new PrismaEvidenceLinkRepository(prisma);
      const conclusionId = randomUUID();
      await withStep('diagnose', () =>
        linkRepo.write(
          scope(CONTEXT, {
            id: randomUUID(),
            evidenceId: input.id,
            conclusionType: 'diagnosis',
            conclusionId,
            relation: 'supports',
          }),
        ),
      );

      await repo.detach(scope(CONTEXT, { id: input.id }));

      // The conclusion's evidence requirement (001 T009, FR-009) is still satisfied — detaching
      // the source evidence is not the same as removing the link, and nothing here ever deletes
      // the evidence_link row: the FK from evidence_link to evidence has no ON DELETE CASCADE,
      // because detach never deletes the row it points at, only marks it.
      await expect(
        assertHasEvidence(linkRepo, scope(CONTEXT, { conclusionType: 'diagnosis', conclusionId })),
      ).resolves.toBeUndefined();

      const detached = await repo.findById(scope(CONTEXT, { id: input.id }));
      expect(detached).toMatchObject({
        refState: 'detached',
        excerpt: input.excerpt,
        sourceLabel: input.sourceLabel,
      });
    }));

  it('listByIssue returns every evidence record for the issue, oldest first (001 T031, FR-007)', () =>
    withCorrelation(newCorrelationId(), async () => {
      // A far-future observedAt keeps these two last regardless of what earlier tests in this
      // shared-fixture file already recorded against the same ISSUE_ID.
      const first = newEvidence({ observedAt: new Date('2027-01-01T00:00:00Z') });
      const second = newEvidence({
        type: 'trace_shape',
        observedAt: new Date('2027-01-02T00:00:00Z'),
      });
      await repo.record(scope(CONTEXT, first));
      await repo.record(scope(CONTEXT, second));

      const all = await repo.listByIssue(scope(CONTEXT, { issueId: ISSUE_ID }));
      const ids = all.map((e) => e.id);
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
      expect(all[all.length - 2]?.id).toBe(first.id);
      expect(all[all.length - 1]?.id).toBe(second.id);
    }));

  it('listByIssue narrows to one type when asked', () =>
    withCorrelation(newCorrelationId(), async () => {
      const errorEvidence = newEvidence();
      const traceEvidence = newEvidence({ type: 'trace_shape' });
      await repo.record(scope(CONTEXT, errorEvidence));
      await repo.record(scope(CONTEXT, traceEvidence));

      const traces = await repo.listByIssue(
        scope(CONTEXT, { issueId: ISSUE_ID, type: 'trace_shape' }),
      );
      expect(traces.map((e) => e.id)).toContain(traceEvidence.id);
      expect(traces.every((e) => e.type === 'trace_shape')).toBe(true);
    }));

  it('listByIssue never returns another tenant’s evidence', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newEvidence();
      await repo.record(scope(CONTEXT, input));

      const foundByOtherTenant = await repo.listByIssue(
        scope(OTHER_CONTEXT, { issueId: ISSUE_ID }),
      );
      expect(foundByOtherTenant.some((e) => e.id === input.id)).toBe(false);
    }));

  it(
    'a 40 MB excerpt is bounded at capture and marked truncated; the reference is kept regardless (001 T032, R-05, quickstart 13)',
    () =>
      withCorrelation(newCorrelationId(), async () => {
        const huge = 'x'.repeat(40 * 1024 * 1024); // 40 MB, quickstart 13's own number
        const id = randomUUID();
        const recorded = await recordEvidence(
          repo,
          CONTEXT,
          {
            id,
            issueId: ISSUE_ID,
            sourceSystem: 'loki',
            sourceRef: 'query-ref-for-the-full-dump',
            sourceLabel: 'stack dump',
            producedByStep: 'collector',
            observedAt: new Date('2026-01-01T00:00:00Z'),
            expiresAt: new Date('2026-02-01T00:00:00Z'),
            excerpt: huge,
          },
          {
            kind: 'collection_gap',
            what: 'stack dump',
            why: 'oversized',
            withheldByRedaction: false,
          },
        );

        expect(recorded.excerptTruncated).toBe(true);
        expect(recorded.excerpt?.length).toBeLessThan(huge.length);
        // The reference is kept regardless of truncation (R-05: "a bounded extract plus a
        // reference is stored") — it never shrinks or gets replaced by the excerpt itself.
        expect(recorded.sourceRef).toBe('query-ref-for-the-full-dump');

        // Reads back exactly the bounded extract that was stored — not the original 40 MB, and
        // not truncated a second time on the way out.
        const found = await repo.findById(scope(CONTEXT, { id }));
        expect(found?.excerpt).toBe(recorded.excerpt);
        expect(found?.excerptTruncated).toBe(true);
      }),
    30_000,
  );
});
