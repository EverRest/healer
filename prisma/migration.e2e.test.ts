import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../test/containers.js';

/**
 * The migration is applied to a clean database and then reversed. This is the part of phase
 * 3's `db-check` (T021) that can already be asserted, and it is what makes
 * "migrations are reversible" a fact rather than a claim in a runbook.
 *
 * Requires a running Docker daemon. It fails rather than skips when Docker is absent: a test
 * that quietly skips is how the reverse migration stops being exercised.
 */
const MIGRATION = new URL(
  './migrations/20260924120000_init_foundation/migration.sql',
  import.meta.url,
).pathname;
const DOWN = new URL('./migrations/20260924120000_init_foundation/down.sql', import.meta.url)
  .pathname;

describe('initial migration', () => {
  let pg: StartedPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('applies to a clean database', async () => {
    await applySqlFile(pg, MIGRATION);
    const schemas = await query(
      pg,
      `select string_agg(nspname, ',' order by nspname) from pg_namespace
       where nspname in ('workflow','prompt','tenant','runner','agent')`,
    );
    expect(schemas).toBe('agent,prompt,runner,tenant,workflow');
  });

  it('creates every tenant-scoped table with a tenant_id column', async () => {
    const missing = await query(
      pg,
      `select coalesce(string_agg(c.relname, ','), '') from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r'
         and n.nspname in ('workflow','runner','agent','tenant')
         and c.relname not in ('tenant')
         and not exists (
           select 1 from pg_attribute a
           where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0
         )`,
    );
    expect(missing).toBe('');
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

  it('reverses cleanly, leaving no table behind', async () => {
    await applySqlFile(pg, DOWN);
    const remaining = await query(
      pg,
      `select coalesce(string_agg(c.relname, ','), '') from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r' and n.nspname in ('workflow','prompt','tenant','runner','agent')`,
    );
    expect(remaining).toBe('');
  });
});
