import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { PrismaEvidenceRepository, type NewEvidence } from '@healer/domain-evidence';
import {
  NotFoundError,
  TenantContext,
  newCorrelationId,
  scope,
  withCorrelation,
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
});
