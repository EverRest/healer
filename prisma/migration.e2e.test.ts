import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../test/containers.js';

/**
 * Every migration under prisma/migrations/, applied and reversed against a real disposable
 * Postgres (012 T021). This is the one place that owns "migrations apply cleanly, reverse
 * cleanly, carry tenant_id with a leading index, and match schema.prisma" — db-check.mjs
 * delegates to this file rather than re-parsing migration SQL with a second, necessarily
 * divergent static reader.
 *
 * Requires a running Docker daemon. It fails rather than skips when Docker is absent: a test
 * that quietly skips is how a reverse migration stops being exercised.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

// Tables that are deliberately not tenant-scoped (data-model.md): the tenant root itself,
// and prompts, which are a global registry shared across tenants.
const GLOBAL_TABLES = new Set([
  'tenant.tenant',
  'prompt.prompt_version',
  // 001: versioned product-level fingerprint rules, not tenant-configurable — the same shape as
  // prompt_version (data-model.md "normalisation_ruleset").
  'issue.normalisation_ruleset',
]);

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationSqlPath(name: string, file: 'migration.sql' | 'down.sql'): string {
  return `${MIGRATIONS_DIR}${name}/${file}`;
}

describe('migrations', () => {
  let pg: StartedPostgres;
  const names = migrationNames();

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of names) {
      await applySqlFile(pg, migrationSqlPath(name, 'migration.sql'));
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('applies every migration, in order, to a clean database', async () => {
    const schemas = await query(
      pg,
      `select string_agg(nspname, ',' order by nspname) from pg_namespace
       where nspname in ('workflow','prompt','tenant','runner','agent')`,
    );
    expect(schemas).toBe('agent,prompt,runner,tenant,workflow');
  });

  it('gives every tenant-scoped table a tenant_id column (012 T021, prisma-migrations rule)', async () => {
    const missing = await query(
      pg,
      `select coalesce(string_agg(n.nspname || '.' || c.relname, ','), '') from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r'
         and n.nspname not in ('public', 'information_schema')
         and n.nspname not like 'pg\\_%'
         and n.nspname || '.' || c.relname not in (${[...GLOBAL_TABLES].map((t) => `'${t}'`).join(', ')})
         and not exists (
           select 1 from pg_attribute a
           where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0
         )`,
    );
    expect(missing).toBe('');
  });

  it('gives every tenant-scoped table a leading tenant_id index (012 T021, prisma-migrations rule)', async () => {
    const withoutLeadingIndex = await query(
      pg,
      `select coalesce(string_agg(n.nspname || '.' || t.relname, ','), '') from pg_class t
       join pg_namespace n on n.oid = t.relnamespace
       where t.relkind = 'r'
         and n.nspname not in ('public', 'information_schema')
         and n.nspname not like 'pg\\_%'
         and n.nspname || '.' || t.relname not in (${[...GLOBAL_TABLES].map((tbl) => `'${tbl}'`).join(', ')})
         and exists (
           select 1 from pg_attribute a
           where a.attrelid = t.oid and a.attname = 'tenant_id' and a.attnum > 0
         )
         and not exists (
           select 1 from pg_index i
           join pg_attribute ia on ia.attrelid = i.indrelid and ia.attnum = i.indkey[0]
           where i.indrelid = t.oid and ia.attname = 'tenant_id'
         )`,
    );
    expect(withoutLeadingIndex).toBe('');
  });

  it('creates the deadline index as a partial index over live runs only', async () => {
    const definition = await query(
      pg,
      `select indexdef from pg_indexes
       where indexname = 'workflow_run_deadline_at_live_idx'`,
    );
    expect(definition).toContain('WHERE (terminal_state IS NULL)');
  });

  it('installs only the extensions ADR 0004 approves', async () => {
    const extensions = await query(
      pg,
      `select string_agg(extname, ',' order by extname) from pg_extension
       where extname not in ('plpgsql')`,
    );
    expect(extensions).toBe('pg_trgm,vector');
  });

  it('matches schema.prisma exactly — no drift between the schema and the committed migrations (012 T021)', () => {
    const output = execFileSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-url',
        pg.url,
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--script',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: pg.url } },
    );
    const statements = output
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([]);
  });

  it('applies cleanly on top of the previous release schema, when one exists (FR-010)', async () => {
    const tags = execFileSync('git', ['tag', '-l', 'v*'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    if (tags.length === 0) {
      // No previous release is tagged yet — there is nothing to verify against. Recorded
      // as a passing assertion on that fact, rather than a silently skipped test, so the
      // gap is visible in the test list and becomes a real check the day a release ships.
      expect(tags).toEqual([]);
      return;
    }

    const latestTag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match=v*'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const priorNames = execFileSync(
      'git',
      ['ls-tree', '-d', '--name-only', `${latestTag}:prisma/migrations`],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
    const newNames = names.filter((name) => !priorNames.includes(name));

    const releasePg = await startPostgres();
    try {
      for (const name of priorNames) {
        const sql = execFileSync(
          'git',
          ['show', `${latestTag}:prisma/migrations/${name}/migration.sql`],
          {
            cwd: REPO_ROOT,
            encoding: 'utf8',
          },
        );
        await query(releasePg, sql);
      }
      for (const name of newNames) {
        await applySqlFile(releasePg, migrationSqlPath(name, 'migration.sql'));
      }
    } finally {
      await releasePg.stop();
    }
  }, 180_000);

  it('reverses every migration cleanly, most recent first, leaving no table behind', async () => {
    for (const name of [...names].reverse()) {
      await applySqlFile(pg, migrationSqlPath(name, 'down.sql'));
    }
    // Review finding (004): this list was hardcoded to the schemas 001/012 introduced and never
    // grew when 004 added "architecture" — adding it here closes that specific blind spot. NOT
    // widened to "every non-system schema" — most of the schemas below (all but "events", per
    // `20260927030000_outbox`'s own down.sql) never drop themselves either, a pre-existing gap in
    // migrations this feature does not own and has no authority to amend.
    const remaining = await query(
      pg,
      `select coalesce(string_agg(c.relname, ','), '') from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r' and n.nspname in ('workflow','prompt','tenant','runner','agent','architecture')`,
    );
    expect(remaining).toBe('');

    // Review finding (004): the table-count check above cannot, by construction, ever catch a
    // `down.sql` that drops every table but forgets `DROP SCHEMA` — an empty, undropped schema
    // has zero tables in it, so the query above sees nothing wrong either way. "architecture" is
    // the one schema this feature owns end-to-end and is the one whose down.sql we can promise
    // drops its own schema (matching "events", the one other schema in this repo that does) —
    // asserted directly against pg_namespace, not by counting tables.
    const architectureSchemaStillExists = await query(
      pg,
      `select count(*) from pg_namespace where nspname = 'architecture'`,
    );
    expect(architectureSchemaStillExists).toBe('0');
  });
});
