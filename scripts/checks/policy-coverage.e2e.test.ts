import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { findUncoveredMutatingActions } from './policy-coverage.mjs';

/**
 * `check:policy-coverage`'s real, live-database query (002 T031, SC-001, R-14), proven against a
 * real Postgres: `audit_entry` left-joined to `policy_decision` on `(tenant_id, action, target_id)`
 * — `policy_action.mutating` selects the rows that need a decision, and a consumed `ALLOW` is what
 * satisfies one.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000f1';
const TARGET_COVERED = '00000000-0000-0000-8000-0000000000f2';
const TARGET_UNCOVERED = '00000000-0000-0000-8000-0000000000f3';
const TARGET_READ_ONLY = '00000000-0000-0000-8000-0000000000f4';

describe('check:policy-coverage against a real Postgres (002 T031, SC-001, R-14)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }

    await query(
      pg,
      `insert into "policy"."policy_action" (action_key, action_class, mutating, owning_spec, introduced_at)
       values
         ('change.open_pull_request', 'code_change', true, '008', now()),
         ('issue.view', 'read_only', false, '001', now())`,
    );

    // Covered: a mutating action with a matching, consumed ALLOW decision behind it.
    await query(
      pg,
      `insert into "policy"."policy_decision"
         (id, tenant_id, action_key, target_ref, proposal_digest, decision_input, ruleset_version,
          outcome, ceiling_applied, budget_state, evaluated_at, consumed_at)
       values
         ('00000000-0000-0000-8000-0000000000f5', '${TENANT_ID}', 'change.open_pull_request',
          '${TARGET_COVERED}', 'digest-1', '{}', 1, 'allow', false, '{}', now(), now())`,
    );

    await query(
      pg,
      `insert into "audit"."audit_entry"
         (id, tenant_id, actor_type, actor_ref, action, target_type, target_id, reason,
          evidence_ids, outcome)
       values
         ('00000000-0000-0000-8000-0000000000f6', '${TENANT_ID}', 'human', 'pavlo',
          'change.open_pull_request', 'issue', '${TARGET_COVERED}', 'opened fix pr', '{}', 'ok'),
         ('00000000-0000-0000-8000-0000000000f7', '${TENANT_ID}', 'human', 'pavlo',
          'change.open_pull_request', 'issue', '${TARGET_UNCOVERED}', 'opened fix pr', '{}', 'ok'),
         ('00000000-0000-0000-8000-0000000000f8', '${TENANT_ID}', 'human', 'pavlo',
          'issue.view', 'issue', '${TARGET_READ_ONLY}', 'viewed issue', '{}', 'ok')`,
    );

    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('flags only the mutating action with no consumed ALLOW behind it', async () => {
    const violations = await findUncoveredMutatingActions(prisma);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('00000000-0000-0000-8000-0000000000f7');
    expect(violations[0]).toContain('change.open_pull_request');
    expect(violations[0]).toContain(TARGET_UNCOVERED);
  });
});
