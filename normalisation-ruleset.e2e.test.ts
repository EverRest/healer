import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `normalisation_ruleset` as versioned data (001 T011, R-01, FR-003): "never edited; a change is
 * a new version" (data-model.md) enforced the same way as evidence/audit — a database trigger,
 * not application discipline — and an issue's `ruleset_version` can only ever name a version that
 * really was published: a foreign key, not a plain int a caller could invent.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-000000000f01';

describe('normalisation_ruleset guarantees (001 T011, R-01, FR-003)', () => {
  let pg: StartedPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`,
    );
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('rejects UPDATE — never edited, a change is a new version', async () => {
    await expect(
      query(
        pg,
        `update "issue"."normalisation_ruleset" set rules = '{"changed":true}' where version = 1`,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE without the privileged bypass', async () => {
    await expect(
      query(pg, `delete from "issue"."normalisation_ruleset" where version = 1`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects a plain TRUNCATE — Postgres itself refuses it because issue.issue references this table', async () => {
    await expect(query(pg, `truncate "issue"."normalisation_ruleset"`)).rejects.toThrow(
      /referenced in a foreign key constraint/,
    );
  });

  it('rejects TRUNCATE ... CASCADE too — the trigger itself, not just the FK, refuses it', async () => {
    await expect(query(pg, `truncate "issue"."normalisation_ruleset" cascade`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('accepts a second, later version — a change is a new row, not an edit', async () => {
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (2, '{"v":2}')`,
    );
    const rows = await query(pg, `select count(*) from "issue"."normalisation_ruleset"`);
    expect(rows).toBe('2');
  });

  it("rejects an issue naming a ruleset_version that was never published — the FK, not a caller's honesty", async () => {
    await expect(
      query(
        pg,
        `insert into "issue"."issue"
           (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
            occurrence_count, first_seen_at, last_seen_at)
         values ('00000000-0000-0000-0000-000000000f02', '${TENANT_ID}', 'production_incident',
                 'prod', 'high', 'detected', 'fp1', 999, 1, now(), now())`,
      ),
    ).rejects.toThrow();
  });

  it('accepts an issue naming a ruleset_version that really was published', async () => {
    await query(
      pg,
      `insert into "issue"."issue"
         (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
          occurrence_count, first_seen_at, last_seen_at)
       values ('00000000-0000-0000-0000-000000000f03', '${TENANT_ID}', 'production_incident',
               'prod', 'high', 'detected', 'fp2', 1, 1, now(), now())`,
    );
    const rows = await query(
      pg,
      `select count(*) from "issue"."issue" where id = '00000000-0000-0000-0000-000000000f03'`,
    );
    expect(rows).toBe('1');
  });
});
