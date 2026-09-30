import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `architecture.edge_provenance` append-only (004 T011, FR-008) — reuses the existing generic
 * `reject_mutation_unless_privileged()` / `reject_truncate_unless_privileged()` trigger functions
 * from migration 20260927000000 (same wiring as `evidence.evidence_link`), not redefined here.
 * `graph_edge.strength`/`.confidence` are maintained as the **maximum** over that edge's
 * `edge_provenance` rows (data-model.md) — a trigger-maintained denormalized column, updated on
 * every insert, not a read-time `MAX()` (a purely read-time aggregate would never "drift" from
 * itself, so it would not match `check:edge-strength-max`'s premise of a continuous invariant
 * that *can* drift).
 *
 * Post-review fixes: the maintenance trigger now (1) recomputes a real `MAX()` over
 * `edge_provenance` rows rather than an incremental `GREATEST()` against the edge's own possibly
 * -wrong founding value, and (2) only ever touches the **open** row for an edge_id
 * (`valid_to_version = 2147483647`) — a closed/historical row must stay exactly as it was at the
 * version it was closed, or a pinned query (FR-014, SC-005) would see it change. `edge_provenance`
 * also now has the same "every non-human provenance carries an observation" CHECK as `graph_node`.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-00000000a011';

describe('architecture.edge_provenance: append-only + graph_edge max-maintenance (004 T011)', () => {
  let pg: StartedPostgres;
  let fromId: string;
  let toId: string;
  let edgeId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    fromId = randomUUID();
    toId = randomUUID();
    edgeId = randomUUID();
    for (const id of [fromId, toId]) {
      await query(
        pg,
        `insert into "architecture"."graph_node"
           (id, tenant_id, node_kind, layer, name, natural_key, provenance, strength, confidence,
            state, observation_ref, valid_from_version)
         values ('${id}', '${TENANT_ID}', 'component', 'code', 'n', 'nk-${id}',
                 'derived_from_code', 30, 50, 'proposed', '${randomUUID()}', 1)`,
      );
    }
    // Baseline graph_edge strength/confidence deliberately low, so the max-maintenance trigger's
    // effect (raising them, never lowering them) is unambiguous to observe.
    await query(
      pg,
      `insert into "architecture"."graph_edge"
         (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
          confidence, state, valid_from_version)
       values ('${edgeId}', '${TENANT_ID}', '${fromId}', '${toId}', 'depends_on', 'code',
               'derived_from_code', 5, 5, 'proposed', 1)`,
    );
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  const insertProvenanceFor = (targetEdgeId: string, strength: number, confidence: number) =>
    query(
      pg,
      `insert into "architecture"."edge_provenance"
         (id, tenant_id, edge_id, provenance, strength, confidence, observation_ref, adapter_key,
          adapter_version)
       values ('${randomUUID()}', '${TENANT_ID}', '${targetEdgeId}', 'derived_from_code',
               ${strength}, ${confidence}, '${randomUUID()}', 'gitlab', '1.0.0')`,
    );

  const insertProvenance = (strength: number, confidence: number) =>
    insertProvenanceFor(edgeId, strength, confidence);

  const currentEdge = () =>
    query(
      pg,
      `select strength || ',' || confidence from "architecture"."graph_edge" where id = '${edgeId}'`,
    );

  it('raises graph_edge.strength/.confidence to the max seen so far, on insert', async () => {
    await insertProvenance(30, 50);
    expect(await currentEdge()).toBe('30,50');
  });

  it('never lowers them for a weaker later observation', async () => {
    await insertProvenance(20, 40);
    expect(await currentEdge()).toBe('30,50');
  });

  it('raises only the field that actually improved', async () => {
    await insertProvenance(70, 10);
    expect(await currentEdge()).toBe('70,50');
  });

  it('recomputes a true MAX() over edge_provenance, ignoring a wrong founding value', async () => {
    // A graph_edge whose own founding strength/confidence (set at its own INSERT, before any
    // edge_provenance row exists) is *higher* than anything edge_provenance actually records —
    // nothing enforces agreement between the two yet (that is T040's future job). The maintenance
    // trigger must trust edge_provenance's true MAX(), not the edge's own column, so this founding
    // value should be *lowered* to match reality once a provenance row lands.
    const f = randomUUID();
    const t = randomUUID();
    for (const id of [f, t]) {
      await query(
        pg,
        `insert into "architecture"."graph_node"
           (id, tenant_id, node_kind, layer, name, natural_key, provenance, strength, confidence,
            state, observation_ref, valid_from_version)
         values ('${id}', '${TENANT_ID}', 'component', 'code', 'n', 'nk-${id}',
                 'derived_from_code', 30, 50, 'proposed', '${randomUUID()}', 1)`,
      );
    }
    const wrongFoundingEdgeId = randomUUID();
    await query(
      pg,
      `insert into "architecture"."graph_edge"
         (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
          confidence, state, valid_from_version)
       values ('${wrongFoundingEdgeId}', '${TENANT_ID}', '${f}', '${t}', 'depends_on', 'code',
               'derived_from_code', 99, 99, 'proposed', 1)`,
    );
    await insertProvenanceFor(wrongFoundingEdgeId, 40, 40);
    const result = await query(
      pg,
      `select strength || ',' || confidence from "architecture"."graph_edge" where id = '${wrongFoundingEdgeId}'`,
    );
    expect(result).toBe('40,40');
  });

  it('never touches a closed (historical) row when a later provenance insert targets it', async () => {
    const f = randomUUID();
    const t = randomUUID();
    for (const id of [f, t]) {
      await query(
        pg,
        `insert into "architecture"."graph_node"
           (id, tenant_id, node_kind, layer, name, natural_key, provenance, strength, confidence,
            state, observation_ref, valid_from_version)
         values ('${id}', '${TENANT_ID}', 'component', 'code', 'n', 'nk-${id}',
                 'derived_from_code', 30, 50, 'proposed', '${randomUUID()}', 1)`,
      );
    }
    const closedEdgeId = randomUUID();
    const openEdgeId = randomUUID();
    // v1 of this logical edge, closed at version 1 (superseded by v2 below) — same
    // (tenant, from, to, edge_type, layer), which is what makes them "the same logical edge".
    await query(
      pg,
      `insert into "architecture"."graph_edge"
         (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
          confidence, state, valid_from_version, valid_to_version)
       values ('${closedEdgeId}', '${TENANT_ID}', '${f}', '${t}', 'depends_on', 'code',
               'derived_from_code', 10, 10, 'proposed', 1, 1)`,
    );
    // v2 — the open successor.
    await query(
      pg,
      `insert into "architecture"."graph_edge"
         (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
          confidence, state, valid_from_version)
       values ('${openEdgeId}', '${TENANT_ID}', '${f}', '${t}', 'depends_on', 'code',
               'derived_from_code', 10, 10, 'proposed', 2)`,
    );

    // A late-arriving observation is recorded against the OLD (now closed) edge id.
    await insertProvenanceFor(closedEdgeId, 99, 99);

    const closed = await query(
      pg,
      `select strength || ',' || confidence from "architecture"."graph_edge" where id = '${closedEdgeId}'`,
    );
    expect(closed).toBe('10,10');

    const open = await query(
      pg,
      `select strength || ',' || confidence from "architecture"."graph_edge" where id = '${openEdgeId}'`,
    );
    expect(open).toBe('10,10');
  });

  it('rejects a non-human-provenance row with no observation_ref', async () => {
    await expect(
      query(
        pg,
        `insert into "architecture"."edge_provenance"
           (id, tenant_id, edge_id, provenance, strength, confidence, adapter_key, adapter_version)
         values ('${randomUUID()}', '${TENANT_ID}', '${edgeId}', 'derived_from_trace', 50, 50,
                 'otel', '1.0.0')`,
      ),
    ).rejects.toThrow();
  });

  it('rejects an UPDATE on an edge_provenance row', async () => {
    const rows = await query(
      pg,
      `select id from "architecture"."edge_provenance" where edge_id = '${edgeId}' limit 1`,
    );
    await expect(
      query(pg, `update "architecture"."edge_provenance" set strength = 1 where id = '${rows}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects a DELETE on an edge_provenance row', async () => {
    const rows = await query(
      pg,
      `select id from "architecture"."edge_provenance" where edge_id = '${edgeId}' limit 1`,
    );
    await expect(
      query(pg, `delete from "architecture"."edge_provenance" where id = '${rows}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects a TRUNCATE of edge_provenance', async () => {
    await expect(query(pg, `truncate "architecture"."edge_provenance"`)).rejects.toThrow(
      /append-only/,
    );
  });
});
