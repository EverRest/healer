import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { findExpiredLinkedEvidence } from './expired-evidence.mjs';

/**
 * `check:expired-evidence`'s real, live-database query (001 T035), proven against a real
 * Postgres with the actual migrations applied — the unit test (`expired-evidence.test.ts`)
 * covers only the message formatting, never the SQL itself.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-000000000f01';
const ISSUE_ID = '00000000-0000-0000-0000-000000000f02';

async function insertEvidence(
  pg: StartedPostgres,
  id: string,
  refState: 'linked' | 'detached',
  expiresAt: string,
) {
  await query(
    pg,
    `insert into "evidence"."evidence"
       (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
        produced_by_step, ref_state, observed_at, expires_at)
     values ('${id}', '${TENANT_ID}', '${ISSUE_ID}', 'error_signature', 'loki', 'ref1',
             'from logs', '{}', 'collector', '${refState}', now(), ${expiresAt})`,
  );
}

describe('check:expired-evidence against a real Postgres (001 T035)', () => {
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
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('flags linked evidence past its expiry, and only that', async () => {
    await insertEvidence(
      pg,
      '00000000-0000-0000-0000-000000000f10',
      'linked',
      "now() - interval '1 day'",
    );
    await insertEvidence(
      pg,
      '00000000-0000-0000-0000-000000000f11',
      'linked',
      "now() + interval '30 days'",
    );
    await insertEvidence(
      pg,
      '00000000-0000-0000-0000-000000000f12',
      'detached',
      "now() - interval '1 day'",
    );

    const violations = await findExpiredLinkedEvidence(prisma);
    const ids = violations.map((v) => v.id);
    expect(ids).toContain('00000000-0000-0000-0000-000000000f10');
    expect(ids).not.toContain('00000000-0000-0000-0000-000000000f11'); // not expired
    expect(ids).not.toContain('00000000-0000-0000-0000-000000000f12'); // expired but detached
  });
});
