import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * Review finding (004 Phase 3, both reviewers): `20261004000000_t018_t035..._checks/down.sql`'s
 * `DELETE FROM "evidence"."evidence" WHERE "issue_id" IS NULL` is rejected by the generic
 * `evidence_append_only` trigger (`reject_mutation_unless_privileged()`,
 * 20260927000000_issue_evidence_audit) on any database that actually holds a discovery evidence
 * row — `prisma/migration.e2e.test.ts`'s own reverse-migration test only ever passed because it
 * runs against a database nothing was ever inserted into. This test seeds exactly the row the
 * forward migration makes representable (a `graph_fact` with a null `issue_id`) before reversing,
 * so the DELETE is actually exercised against a non-empty table.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));
function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-00000000e001';

describe('20261004000000_t018_t035..._checks down.sql, against a seeded discovery evidence row', () => {
  let pg: StartedPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames())
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('reverses cleanly even when a graph_fact row with a null issue_id exists', async () => {
    const evidenceId = randomUUID();
    await query(
      pg,
      `insert into "evidence"."evidence"
         (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
          produced_by_step, observed_at, expires_at)
       values ('${evidenceId}', '${TENANT_ID}', null, 'graph_fact', 'gitlab', 'run-1', 'gitlab discovery run run-1',
               '{"kind":"component_candidate"}'::jsonb, 'architecture.discovery', now(), '9999-12-31T00:00:00Z')`,
    );
    expect(
      await query(pg, `select count(*) from "evidence"."evidence" where id = '${evidenceId}'`),
    ).toBe('1');

    // The DELETE this down.sql issues must actually succeed (not be silently swallowed by
    // ON_ERROR_STOP being satisfied some other way) — applySqlFile throws on a non-zero psql exit.
    await applySqlFile(
      pg,
      `${MIGRATIONS_DIR}20261004000000_t018_t035_discovery_evidence_and_draft_checks/down.sql`,
    );

    expect(
      await query(pg, `select count(*) from "evidence"."evidence" where id = '${evidenceId}'`),
    ).toBe('0');

    // NOT NULL is genuinely restored, not merely "the DELETE happened to succeed".
    await expect(
      query(
        pg,
        `insert into "evidence"."evidence"
           (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
            produced_by_step, observed_at, expires_at)
         values ('${randomUUID()}', '${TENANT_ID}', null, 'graph_fact', 'gitlab', 'run-2', 'x',
                 '{}'::jsonb, 'architecture.discovery', now(), '9999-12-31T00:00:00Z')`,
      ),
    ).rejects.toThrow();
  });
});
