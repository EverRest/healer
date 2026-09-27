import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { findUnlinkedConclusions } from './evidence-coverage.mjs';

/**
 * `check:evidence-coverage`'s real, live-database query (001 T033, SC-002), proven against a
 * real Postgres — no 003+ conclusion table exists yet to exercise this against for real, so this
 * fabricates a minimal one (a bare `id`/`tenant_id` table, not a real `@conclusion`-tagged
 * model) purely to prove the query itself is correct; `findUnlinkedConclusions` takes its table
 * list as plain data, so it needs no real tagged model to be exercised honestly.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-000000000f21';
const ISSUE_ID = '00000000-0000-0000-0000-000000000f22';
const EVIDENCE_ID = '00000000-0000-0000-0000-000000000f23';
const LINKED_CONCLUSION_ID = '00000000-0000-0000-0000-000000000f24';
const UNLINKED_CONCLUSION_ID = '00000000-0000-0000-0000-000000000f25';

describe('check:evidence-coverage against a real Postgres (001 T033, SC-002)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

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
    // A stand-in conclusion table — real conclusion tables belong to 003+, not built yet.
    await query(
      pg,
      `create table "evidence"."diagnosis_fixture" (id uuid primary key, tenant_id uuid)`,
    );
    await query(
      pg,
      `insert into "evidence"."diagnosis_fixture" (id, tenant_id) values
         ('${LINKED_CONCLUSION_ID}', '${TENANT_ID}'), ('${UNLINKED_CONCLUSION_ID}', '${TENANT_ID}')`,
    );
    await query(
      pg,
      `begin;
       select set_config('healer.current_step', 'diagnose', true);
       insert into "evidence"."evidence_link"
         (id, tenant_id, evidence_id, conclusion_type, conclusion_id, relation, asserted_by_step)
       values ('00000000-0000-0000-0000-000000000f26', '${TENANT_ID}', '${EVIDENCE_ID}',
               'diagnosis', '${LINKED_CONCLUSION_ID}', 'supports', 'diagnose');
       commit;`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('flags only the conclusion row with no evidence_link at all', async () => {
    const violations = await findUnlinkedConclusions(prisma, [
      {
        model: 'DiagnosisFixture',
        type: 'diagnosis',
        schema: 'evidence',
        table: 'diagnosis_fixture',
      },
    ]);
    expect(violations).toEqual([
      `evidence.diagnosis_fixture ${UNLINKED_CONCLUSION_ID} (diagnosis): no evidence_link`,
    ]);
  });
});
