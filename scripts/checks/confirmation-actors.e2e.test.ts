import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { findNonHumanConfirmations } from './confirmation-actors.mjs';

/**
 * `check:confirmation-actors`'s real, live-database query (004 T034, SC-002, SC-003), proven
 * against a real Postgres. `confirmDraftItems`/`requireHumanReviewActor` already refuse a
 * non-human confirm before any write exists — this proves the independent *data* check would
 * catch it anyway, were that structural gate ever bypassed (a direct repository call, a bug, a
 * future caller), the same posture `check:policy-coverage`'s own header explains.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-00000000c001';
const RUN_ID = '00000000-0000-0000-0000-00000000c002';
const DRAFT_ID = '00000000-0000-0000-0000-00000000c003';
const EVIDENCE_ID = '00000000-0000-0000-0000-00000000c004';

const NODE_GOOD = '00000000-0000-0000-0000-00000000c010';
const NODE_BAD = '00000000-0000-0000-0000-00000000c011';
const NODE_MISSING_AUDIT = '00000000-0000-0000-0000-00000000c012';

const ITEM_GOOD = '00000000-0000-0000-0000-00000000c020';
const ITEM_BAD_AGENT = '00000000-0000-0000-0000-00000000c021';
const ITEM_MISSING_AUDIT = '00000000-0000-0000-0000-00000000c022';

describe('check:confirmation-actors against a real Postgres (004 T034, SC-002, SC-003)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }

    await query(
      pg,
      `insert into "architecture"."discovery_run"
         (id, tenant_id, base_version, trigger, runner_id, started_at, finished_at)
       values ('${RUN_ID}', '${TENANT_ID}', 0, 'manual', 'test-runner', now(), now())`,
    );
    await query(
      pg,
      `insert into "evidence"."evidence"
         (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
          produced_by_step, observed_at, expires_at)
       values ('${EVIDENCE_ID}', '${TENANT_ID}', null, 'graph_fact', 'gitlab', '${RUN_ID}',
               'gitlab candidate', '{}', 'architecture.discovery', now(), now() + interval '100 years')`,
    );
    await query(
      pg,
      `insert into "architecture"."discovery_draft"
         (id, tenant_id, run_id, base_version, state, opened_at)
       values ('${DRAFT_ID}', '${TENANT_ID}', '${RUN_ID}', 0, 'open', now())`,
    );

    // Three confirmed graph_node rows — the resulting elements a confirm would have produced.
    for (const nodeId of [NODE_GOOD, NODE_BAD, NODE_MISSING_AUDIT]) {
      await query(
        pg,
        `insert into "architecture"."graph_node"
           (id, tenant_id, node_kind, layer, name, natural_key, provenance, strength, confidence,
            state, actor_ref, valid_from_version, valid_to_version)
         values ('${nodeId}', '${TENANT_ID}', 'component', 'code', 'svc-${nodeId}', 'key-${nodeId}',
                 'human_confirmed', 70, 90, 'confirmed', 'pavlo', 1, 2147483647)`,
      );
    }

    // Three draft_item rows, all state = 'confirmed' with a real decided_by/decided_at and a
    // backfilled target_node_id — exactly what `confirmDraftItems` writes (T026).
    const draftItemInsert = (id: string, nodeId: string, decidedBy: string) =>
      query(
        pg,
        `insert into "architecture"."draft_item"
           (id, tenant_id, draft_id, op, target_node_id, proposed, proposal_digest, provenance,
            strength, confidence, observation_ref, state, decided_by, decided_at)
         values ('${id}', '${TENANT_ID}', '${DRAFT_ID}', 'add_node', '${nodeId}', '{}', '${id}',
                 'derived_from_code', 30, 60, '${EVIDENCE_ID}', 'confirmed', '${decidedBy}', now())`,
      );
    await draftItemInsert(ITEM_GOOD, NODE_GOOD, 'pavlo');
    await draftItemInsert(ITEM_BAD_AGENT, NODE_BAD, 'agent-7');
    await draftItemInsert(ITEM_MISSING_AUDIT, NODE_MISSING_AUDIT, 'pavlo');

    // Audit trail: a real human confirmation, a bypassed agent "confirmation" (the thing SC-002
    // forbids), and nothing at all for the third item (SC-003's "no audited path" shape).
    await query(
      pg,
      `insert into "audit"."audit_entry"
         (id, tenant_id, actor_type, actor_ref, action, target_type, target_id, reason,
          evidence_ids, outcome, graph_version, agent_run_id)
       values
         ('00000000-0000-0000-0000-00000000c030', '${TENANT_ID}', 'human', 'pavlo',
          'architecture.draft_item.confirm', 'graph_node', '${NODE_GOOD}', 'confirmed', '{}', 'ok', 1,
          null),
         ('00000000-0000-0000-0000-00000000c031', '${TENANT_ID}', 'agent', 'agent-7',
          'architecture.draft_item.confirm', 'graph_node', '${NODE_BAD}', 'confirmed', '{}', 'ok', 1,
          '00000000-0000-0000-0000-00000000c099')`,
    );

    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('flags the agent-confirmed audit_entry directly (SC-002) and both affected draft_items (SC-003), nothing else', async () => {
    const violations = await findNonHumanConfirmations(prisma);

    expect(violations.some((v) => v.includes('00000000-0000-0000-0000-00000000c031'))).toBe(true);
    expect(violations.filter((v) => v.includes('SC-002'))).toHaveLength(1);

    const badDraftItem = violations.find((v) => v.includes(ITEM_BAD_AGENT));
    expect(badDraftItem).toBeDefined();
    expect(badDraftItem).toContain("actor_type is 'agent'");

    const missingAuditItem = violations.find((v) => v.includes(ITEM_MISSING_AUDIT));
    expect(missingAuditItem).toBeDefined();
    expect(missingAuditItem).toContain('no matching human-actor audit entry');

    expect(violations.some((v) => v.includes(ITEM_GOOD))).toBe(false);
  });
});
