import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 003 T004 (FR-022): the seven append-only `context` tables reject UPDATE, DELETE and TRUNCATE in
 * the database itself — raw SQL, so no repository could route around it. Pure append-only, applied
 * literally; the lifecycle columns this blocks are logged in QUESTIONS.md.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));
const T = '00000000-0000-0000-0000-000000000c01';
const ISSUE = '00000000-0000-0000-0000-000000000c02';
const RUN = '00000000-0000-0000-0000-000000000c03';
const SNAPSHOT = '00000000-0000-0000-0000-000000000c04';
const PASS = '00000000-0000-0000-0000-000000000c05';
const RUNNER = '00000000-0000-0000-0000-000000000c06';

// table -> [insert SQL, UPDATE SQL]
const TABLES: Record<string, readonly [string, string]> = {
  context_snapshot: [
    `insert into context.context_snapshot (id, tenant_id, issue_id, version, collected_at, window_from,
       window_to, plan_digest, collection_ruleset_version, ranking_ruleset_version,
       redaction_ruleset_version, normalisation_ruleset_version, contract_version, runner_id,
       runner_image_version, completeness, budget_state, finalised_at)
     values ('${SNAPSHOT}', '${T}', '${ISSUE}', 1, now(), now(), now(), 'd', 1, 1, 1, 1, 1, '${RUNNER}',
       'img', '{}', 'within', now())`,
    `update context.context_snapshot set plan_digest = 'x'`,
  ],
  collection_pass: [
    `insert into context.collection_pass (id, tenant_id, snapshot_id, pass_ordinal, plan_digest,
       requested_plan, resolved_plan, requested_by_step, workflow_run_id, callback_id, dispatched_at, outcome)
     values ('${PASS}', '${T}', '${SNAPSHOT}', 0, 'd', '{}', '{}', 'system', '${RUN}', '${RUN}', now(), 'completed')`,
    `update context.collection_pass set outcome = 'partial'`,
  ],
  source_outcome: [
    `insert into context.source_outcome (id, tenant_id, pass_id, collector_key, status, item_count,
       truncated, duration_ms) values (gen_random_uuid(), '${T}', '${PASS}', 'loki_logs', 'collected', 1, false, 5)`,
    `update context.source_outcome set item_count = 2`,
  ],
  boundary_rejection: [
    `insert into context.boundary_rejection (id, tenant_id, runner_id, contract_version,
       schema_error_paths, payload_digest, byte_size, received_at)
     values (gen_random_uuid(), '${T}', '${RUNNER}', 1, '{}', 'abc', 3, now())`,
    `update context.boundary_rejection set byte_size = 4`,
  ],
  collection_ruleset: [
    `insert into context.collection_ruleset (version, rules) values (1, '{}')`,
    `update context.collection_ruleset set note = 'x'`,
  ],
  ranking_ruleset: [
    `insert into context.ranking_ruleset (version, terms) values (1, '[]')`,
    `update context.ranking_ruleset set note = 'x'`,
  ],
  redaction_ruleset: [
    `insert into context.redaction_ruleset (version, detectors, runner_min_image_version)
     values (1, '[]', '1.0.0')`,
    `update context.redaction_ruleset set note = 'x'`,
  ],
};

describe('context append-only enforcement (003 T004, FR-022)', () => {
  let pg: StartedPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${entry}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`,
    );
    await query(
      pg,
      `insert into "issue"."issue" (id, tenant_id, kind, environment, severity, state, fingerprint,
         ruleset_version, occurrence_count, first_seen_at, last_seen_at)
       values ('${ISSUE}', '${T}', 'production_incident', 'prod', 'high', 'detected', 'fp', 1, 1, now(), now())`,
    );
    await query(
      pg,
      `insert into "workflow"."workflow_run" (id, tenant_id, issue_id, definition_key,
         definition_version, state, correlation_id, updated_at)
       values ('${RUN}', '${T}', '${ISSUE}', 'diagnose', 1, 'investigating', '${RUN}', now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it.each(Object.entries(TABLES))(
    '%s accepts INSERT and rejects UPDATE, DELETE and TRUNCATE',
    async (table, [insert, update]) => {
      await query(pg, insert);
      await expect(query(pg, update)).rejects.toThrow(/append-only/);
      await expect(query(pg, `delete from context.${table}`)).rejects.toThrow(/append-only/);
      await expect(query(pg, `truncate context.${table} cascade`)).rejects.toThrow(/append-only/);
      expect(await query(pg, `select count(*) from context.${table}`)).toBe('1');
    },
  );

  it('keeps the privileged bypass, as append-only.e2e.test.ts proves for the other tables', async () => {
    await query(
      pg,
      `begin; set local healer.privileged_write = 'on'; delete from context.boundary_rejection; commit;`,
    );
    expect(await query(pg, `select count(*) from context.boundary_rejection`)).toBe('0');
  });

  it('rejects a non-collected outcome without a gap evidence id, and a collected one with it', async () => {
    const base = `insert into context.source_outcome (id, tenant_id, pass_id, collector_key, status,
      item_count, truncated, duration_ms, gap_evidence_id) values (gen_random_uuid(), '${T}', '${PASS}', 'otel_traces'`;
    await expect(query(pg, `${base}, 'unavailable', 0, false, 1, null)`)).rejects.toThrow(
      /source_outcome_gap_evidence_check/,
    );
    await expect(
      query(pg, `${base}, 'collected', 0, false, 1, gen_random_uuid())`),
    ).rejects.toThrow(/source_outcome_gap_evidence_check/);
  });
});
