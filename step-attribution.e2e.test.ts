import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * Producer attribution enforced by the database, not by application discipline (001 T007, FR-008,
 * R-06). "A link created by a step other than the one that observed the fact is detectable" —
 * proven here through raw SQL, so no repository code could route around it even by accident, the
 * same reasoning `append-only.e2e.test.ts` already applies to R-03.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-000000000f01';
const ISSUE_ID = '00000000-0000-0000-0000-000000000f02';
const EVIDENCE_ID = '00000000-0000-0000-0000-000000000f03';

describe('producer attribution on evidence_link (001 T007, FR-008, R-06, quickstart 10)', () => {
  let pg: StartedPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
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
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  function insertLink(id: string, assertedByStep: string): Promise<string> {
    return query(
      pg,
      `insert into "evidence"."evidence_link"
         (id, tenant_id, evidence_id, conclusion_type, conclusion_id, relation, asserted_by_step)
       values ('${id}', '${TENANT_ID}', '${EVIDENCE_ID}', 'diagnosis',
               '00000000-0000-0000-0000-000000000f04', 'supports', '${assertedByStep}')`,
    );
  }

  it('rejects a link with no executing step declared at all', async () => {
    await expect(insertLink('00000000-0000-0000-0000-000000000f10', 'diagnose')).rejects.toThrow(
      /STEP_ATTRIBUTION_MISMATCH/,
    );
  });

  it('rejects a link attributed to a step other than the one executing', async () => {
    await expect(
      query(
        pg,
        `begin;
         select set_config('healer.current_step', 'collector', true);
         insert into "evidence"."evidence_link"
           (id, tenant_id, evidence_id, conclusion_type, conclusion_id, relation, asserted_by_step)
         values ('00000000-0000-0000-0000-000000000f11', '${TENANT_ID}', '${EVIDENCE_ID}', 'diagnosis',
                 '00000000-0000-0000-0000-000000000f05', 'supports', 'diagnose');
         commit;`,
      ),
    ).rejects.toThrow(/STEP_ATTRIBUTION_MISMATCH/);
  });

  it('accepts a link whose asserted_by_step matches the declared executing step', async () => {
    await query(
      pg,
      `begin;
       select set_config('healer.current_step', 'diagnose', true);
       insert into "evidence"."evidence_link"
         (id, tenant_id, evidence_id, conclusion_type, conclusion_id, relation, asserted_by_step)
       values ('00000000-0000-0000-0000-000000000f12', '${TENANT_ID}', '${EVIDENCE_ID}', 'diagnosis',
               '00000000-0000-0000-0000-000000000f06', 'supports', 'diagnose');
       commit;`,
    );
    const count = await query(
      pg,
      `select count(*) from "evidence"."evidence_link" where id = '00000000-0000-0000-0000-000000000f12'`,
    );
    expect(count).toBe('1');
  });
});
