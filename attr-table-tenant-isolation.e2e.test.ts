import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * The six attr tables' FK to `graph_node` must be tenant-safe (FR-024, SC-009) — review finding
 * (004 T002): the FKs originally referenced `graph_node("id")` alone instead of the composite
 * `(id, tenant_id)` every other child table in this migration uses (`graph_edge`,
 * `edge_provenance`, `discovery_draft`, `discovery_source_outcome`, `draft_item`), so a
 * `component_attr` row could name one tenant's `tenant_id` while its `node_id` pointed at another
 * tenant's `graph_node` row — a structural cross-tenant leak, reproduced against live Postgres
 * before the fix. Covers `component_attr` as the representative case; all six attr tables share
 * the identical FK shape (`node_id_tenant_id_fkey` composite).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_A = '00000000-0000-0000-0000-00000000a1aa';
const TENANT_B = '00000000-0000-0000-0000-00000000b1bb';

describe('architecture attr tables: tenant-safe FK to graph_node (004 T002 fix)', () => {
  let pg: StartedPostgres;
  let nodeAId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    nodeAId = randomUUID();
    await query(
      pg,
      `insert into "architecture"."graph_node"
         (id, tenant_id, node_kind, layer, name, natural_key, provenance, strength, confidence,
          state, observation_ref, valid_from_version)
       values ('${nodeAId}', '${TENANT_A}', 'component', 'code', 'n', 'nk-${nodeAId}',
               'derived_from_code', 30, 50, 'proposed', '${randomUUID()}', 1)`,
    );
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('rejects a component_attr row naming another tenant than the node it points at', async () => {
    await expect(
      query(
        pg,
        `insert into "architecture"."component_attr" (node_id, tenant_id, component_type)
         values ('${nodeAId}', '${TENANT_B}', 'service')`,
      ),
    ).rejects.toThrow();
  });

  it('accepts a component_attr row whose tenant matches the node it points at', async () => {
    await query(
      pg,
      `insert into "architecture"."component_attr" (node_id, tenant_id, component_type)
       values ('${nodeAId}', '${TENANT_A}', 'service')`,
    );
    const stored = await query(
      pg,
      `select tenant_id from "architecture"."component_attr" where node_id = '${nodeAId}'`,
    );
    expect(stored).toBe(TENANT_A);
  });
});
