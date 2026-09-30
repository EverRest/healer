import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * Database-level provenance guarantees for `architecture.graph_node` / `graph_edge` (004 T005,
 * T006, FR-005, quickstart scenario 3): "an element with no provenance class cannot be
 * persisted" is a constraint the database enforces, not a rule a repository merely chooses to
 * follow (docs/patterns.md: "prefer making the unsafe state unrepresentable"). Raw SQL, not
 * PrismaClient — so no repository code could route around it even by accident (same technique as
 * `append-only.e2e.test.ts`).
 *
 * T002 leaves `provenance`/`strength`/`confidence`/`layer` nullable and omits the two CHECKs on
 * `graph_node` — every `it` below is written against the *final* (post-T006) shape and is
 * expected to fail red until T006's migration lands in this same worktree.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-00000000a001';

describe('architecture.graph_node / graph_edge provenance constraints (004 T005, T006)', () => {
  let pg: StartedPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  /** `sqlOverrides` values are literal SQL fragments (`'text'`, `null`, `42`) — everything but `id`. */
  const insertNode = (id: string, sqlOverrides: Partial<Record<string, string>> = {}) => {
    const fields: Record<string, string> = {
      id: `'${id}'`,
      tenant_id: `'${TENANT_ID}'`,
      node_kind: `'component'`,
      layer: `'code'`,
      name: `'svc'`,
      natural_key: `'nk-${id}'`,
      provenance: `'derived_from_code'`,
      strength: '30',
      confidence: '50',
      state: `'proposed'`,
      observation_ref: `'${randomUUID()}'`,
      valid_from_version: '1',
      ...sqlOverrides,
    };
    const columns = Object.keys(fields);
    const values = columns.map((column) => fields[column]);
    return query(
      pg,
      `insert into "architecture"."graph_node" (${columns.join(', ')}) values (${values.join(', ')})`,
    );
  };

  it('rejects a node with a null provenance class (FR-005, SC-001)', async () => {
    await expect(insertNode(randomUUID(), { provenance: 'null' })).rejects.toThrow();
  });

  it('rejects an edge with a null provenance class (FR-005, SC-001)', async () => {
    const fromId = randomUUID();
    const toId = randomUUID();
    await insertNode(fromId);
    await insertNode(toId);
    await expect(
      query(
        pg,
        `insert into "architecture"."graph_edge"
           (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
            confidence, state, valid_from_version)
         values ('${randomUUID()}', '${TENANT_ID}', '${fromId}', '${toId}', 'depends_on', 'code',
                 null, 30, 50, 'proposed', 1)`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-human-provenance node with no observation_ref', async () => {
    await expect(insertNode(randomUUID(), { observation_ref: 'null' })).rejects.toThrow();
  });

  it('rejects a human-provenance node with no actor_ref', async () => {
    await expect(
      insertNode(randomUUID(), { provenance: `'human_authored'`, observation_ref: 'null' }),
    ).rejects.toThrow();
  });

  it('accepts a human-provenance node that names an actor and no observation', async () => {
    const id = randomUUID();
    await insertNode(id, {
      provenance: `'human_authored'`,
      observation_ref: 'null',
      actor_ref: `'pavlo'`,
    });
    const stored = await query(
      pg,
      `select provenance from "architecture"."graph_node" where id = '${id}'`,
    );
    expect(stored).toBe('human_authored');
  });

  it('accepts a derived-provenance node that names an observation and no actor', async () => {
    const id = randomUUID();
    await insertNode(id);
    const stored = await query(
      pg,
      `select provenance from "architecture"."graph_node" where id = '${id}'`,
    );
    expect(stored).toBe('derived_from_code');
  });

  /** `sqlOverrides` for graph_edge, same convention as `insertNode`. Seeds its own two nodes. */
  const insertEdge = async (sqlOverrides: Partial<Record<string, string>> = {}) => {
    const fromId = randomUUID();
    const toId = randomUUID();
    await insertNode(fromId);
    await insertNode(toId);
    const fields: Record<string, string> = {
      id: `'${randomUUID()}'`,
      tenant_id: `'${TENANT_ID}'`,
      from_node_id: `'${fromId}'`,
      to_node_id: `'${toId}'`,
      edge_type: `'depends_on'`,
      layer: `'code'`,
      provenance: `'derived_from_code'`,
      strength: '30',
      confidence: '50',
      state: `'proposed'`,
      valid_from_version: '1',
      ...sqlOverrides,
    };
    const columns = Object.keys(fields);
    const values = columns.map((column) => fields[column]);
    return query(
      pg,
      `insert into "architecture"."graph_edge" (${columns.join(', ')}) values (${values.join(', ')})`,
    );
  };

  // Cheap insurance CHECKs (data-model.md describes confidence as "integer 0-100" and R-04's
  // validity range only makes sense with from <= to; neither was ever a CHECK until this fix).
  it('rejects a node confidence outside 0-100', async () => {
    await expect(insertNode(randomUUID(), { confidence: '101' })).rejects.toThrow();
    await expect(insertNode(randomUUID(), { confidence: '-1' })).rejects.toThrow();
  });

  it('rejects an edge confidence outside 0-100', async () => {
    await expect(insertEdge({ confidence: '101' })).rejects.toThrow();
    await expect(insertEdge({ confidence: '-1' })).rejects.toThrow();
  });

  it('rejects a node whose valid_from_version is after its valid_to_version', async () => {
    await expect(
      insertNode(randomUUID(), { valid_from_version: '5', valid_to_version: '4' }),
    ).rejects.toThrow();
  });

  it('rejects an edge whose valid_from_version is after its valid_to_version', async () => {
    await expect(
      insertEdge({ valid_from_version: '5', valid_to_version: '4' }),
    ).rejects.toThrow();
  });
});
