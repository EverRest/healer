import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  assertHasEvidence,
  DuplicateEvidenceLinkError,
  EvidenceRequiredError,
  PrismaEvidenceLinkRepository,
} from '@healer/domain-evidence';
import { TenantContext, scope, withStep } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * The legitimate path through `PrismaEvidenceLinkRepository` (001 T008, FR-008, R-06): a step
 * writes its own link by running inside `withStep(...)`, never by naming a step as an argument —
 * `NewEvidenceLink` has no such field (see `link-repository.ts`), so the "attributed to a
 * different step" scenario `step-attribution.e2e.test.ts` proves the database rejects is not even
 * expressible through this repository — only through raw SQL bypassing it entirely.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000d1';
const ISSUE_ID = '00000000-0000-0000-8000-0000000000d2';
const EVIDENCE_ID = '00000000-0000-0000-8000-0000000000d3';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

describe('PrismaEvidenceLinkRepository (001 T008, FR-008, R-06)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaEvidenceLinkRepository;

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
    await query(
      pg,
      `insert into "evidence"."evidence"
         (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
          produced_by_step, observed_at, expires_at)
       values ('${EVIDENCE_ID}', '${TENANT_ID}', '${ISSUE_ID}', 'error_signature', 'loki', 'ref1',
               'from logs', '{}', 'collector', now(), now() + interval '30 days')`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    repo = new PrismaEvidenceLinkRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('writes a link attributed to whichever step is executing, via withStep — never as an argument', async () => {
    const id = randomUUID();
    const written = await withStep('diagnose', () =>
      repo.write(
        scope(CONTEXT, {
          id,
          evidenceId: EVIDENCE_ID,
          conclusionType: 'diagnosis',
          conclusionId: randomUUID(),
          relation: 'supports',
        }),
      ),
    );
    expect(written).toMatchObject({ id, assertedByStep: 'diagnose', relation: 'supports' });
  });

  it('rejects the write outside any step context, before it ever reaches the database', async () => {
    await expect(
      repo.write(
        scope(CONTEXT, {
          id: randomUUID(),
          evidenceId: EVIDENCE_ID,
          conclusionType: 'diagnosis',
          conclusionId: randomUUID(),
          relation: 'supports',
        }),
      ),
    ).rejects.toThrow(/step/i);
  });

  it('a second step writing about the same evidence is attributed to itself, not to the first step', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    await withStep('collector', () =>
      repo.write(
        scope(CONTEXT, {
          id: idA,
          evidenceId: EVIDENCE_ID,
          conclusionType: 'hypothesis',
          conclusionId: randomUUID(),
          relation: 'contextualises',
        }),
      ),
    );
    const written = await withStep('verify', () =>
      repo.write(
        scope(CONTEXT, {
          id: idB,
          evidenceId: EVIDENCE_ID,
          conclusionType: 'verification',
          conclusionId: randomUUID(),
          relation: 'supports',
        }),
      ),
    );
    expect(written.assertedByStep).toBe('verify');
  });

  it('rejects a second link naming the same (evidence, conclusion, relation) — the closed relation set is not enough on its own (001 T028)', async () => {
    const conclusionId = randomUUID();
    await withStep('diagnose', () =>
      repo.write(
        scope(CONTEXT, {
          id: randomUUID(),
          evidenceId: EVIDENCE_ID,
          conclusionType: 'diagnosis',
          conclusionId,
          relation: 'supports',
        }),
      ),
    );
    await expect(
      withStep('diagnose', () =>
        repo.write(
          scope(CONTEXT, {
            id: randomUUID(),
            evidenceId: EVIDENCE_ID,
            conclusionType: 'diagnosis',
            conclusionId,
            relation: 'supports',
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(DuplicateEvidenceLinkError);
  });

  it('allows the same evidence and conclusion under a different relation — uniqueness is per (evidence, conclusion, relation), not per pair', async () => {
    const conclusionId = randomUUID();
    await withStep('diagnose', () =>
      repo.write(
        scope(CONTEXT, {
          id: randomUUID(),
          evidenceId: EVIDENCE_ID,
          conclusionType: 'diagnosis',
          conclusionId,
          relation: 'supports',
        }),
      ),
    );
    const second = await withStep('diagnose', () =>
      repo.write(
        scope(CONTEXT, {
          id: randomUUID(),
          evidenceId: EVIDENCE_ID,
          conclusionType: 'diagnosis',
          conclusionId,
          relation: 'contradicts',
        }),
      ),
    );
    expect(second.relation).toBe('contradicts');
  });
});

describe('assertHasEvidence (001 T009, FR-009, quickstart 9)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaEvidenceLinkRepository;

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
    await query(
      pg,
      `insert into "evidence"."evidence"
         (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
          produced_by_step, observed_at, expires_at)
       values ('${EVIDENCE_ID}', '${TENANT_ID}', '${ISSUE_ID}', 'error_signature', 'loki', 'ref1',
               'from logs', '{}', 'collector', now(), now() + interval '30 days')`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    repo = new PrismaEvidenceLinkRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('rejects a conclusion with no evidence_link at all — persisting a diagnosis with no link (quickstart 9)', async () => {
    const conclusionId = randomUUID();
    await expect(
      assertHasEvidence(repo, scope(CONTEXT, { conclusionType: 'diagnosis', conclusionId })),
    ).rejects.toBeInstanceOf(EvidenceRequiredError);
  });

  it('passes once a real evidence_link exists for that conclusion', async () => {
    const conclusionId = randomUUID();
    await withStep('diagnose', () =>
      repo.write(
        scope(CONTEXT, {
          id: randomUUID(),
          evidenceId: EVIDENCE_ID,
          conclusionType: 'diagnosis',
          conclusionId,
          relation: 'supports',
        }),
      ),
    );
    await expect(
      assertHasEvidence(repo, scope(CONTEXT, { conclusionType: 'diagnosis', conclusionId })),
    ).resolves.toBeUndefined();
  });

  it('does not confuse one conclusion’s link with another’s of the same type', async () => {
    const linkedConclusionId = randomUUID();
    const unlinkedConclusionId = randomUUID();
    await withStep('diagnose', () =>
      repo.write(
        scope(CONTEXT, {
          id: randomUUID(),
          evidenceId: EVIDENCE_ID,
          conclusionType: 'diagnosis',
          conclusionId: linkedConclusionId,
          relation: 'supports',
        }),
      ),
    );
    await expect(
      assertHasEvidence(
        repo,
        scope(CONTEXT, { conclusionType: 'diagnosis', conclusionId: unlinkedConclusionId }),
      ),
    ).rejects.toBeInstanceOf(EvidenceRequiredError);
  });
});
