import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { findUnresolvableObservationRefs } from './graph-fact-coverage.mjs';

/**
 * `check:graph-fact-coverage`'s real, live-database query (004 T035, FR-027, FR-006, SC-001),
 * proven against a real Postgres across all three tables it covers — `graph_node`,
 * `edge_provenance` and `draft_item` — plus the positive cases that must NOT be flagged: a
 * resolving reference, a `null` reference (human provenance), and a reference to a synthetic
 * `mark_removed` absence row (still `type = 'graph_fact'`, per `prisma-discovery-repository.ts`).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-00000000d001';
const RUN_ID = '00000000-0000-0000-0000-00000000d002';
const DRAFT_ID = '00000000-0000-0000-0000-00000000d003';

const GOOD_EVIDENCE = '00000000-0000-0000-0000-00000000d010';
const ABSENCE_EVIDENCE = '00000000-0000-0000-0000-00000000d011';
const WRONG_TYPE_EVIDENCE = '00000000-0000-0000-0000-00000000d012';

const NODE_OK = '00000000-0000-0000-0000-00000000d020';
const NODE_HUMAN = '00000000-0000-0000-0000-00000000d021';
const NODE_ABSENCE = '00000000-0000-0000-0000-00000000d022';
const NODE_BROKEN = '00000000-0000-0000-0000-00000000d023';
const NODE_FROM = '00000000-0000-0000-0000-00000000d024';
const NODE_TO = '00000000-0000-0000-0000-00000000d025';

const EDGE_OK = '00000000-0000-0000-0000-00000000d030';
const EDGE_BROKEN = '00000000-0000-0000-0000-00000000d031';

const ITEM_OK = '00000000-0000-0000-0000-00000000d040';
const ITEM_BROKEN = '00000000-0000-0000-0000-00000000d041';

describe('check:graph-fact-coverage against a real Postgres (004 T035, FR-027, SC-001)', () => {
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
       values
         ('${GOOD_EVIDENCE}', '${TENANT_ID}', null, 'graph_fact', 'gitlab', '${RUN_ID}',
          'component observed', '{}', 'architecture.discovery', now(), now() + interval '100 years'),
         ('${ABSENCE_EVIDENCE}', '${TENANT_ID}', null, 'graph_fact', 'gitlab', '${RUN_ID}',
          'absence of component', '{"kind":"absence"}', 'architecture.discovery', now(),
          now() + interval '100 years'),
         ('${WRONG_TYPE_EVIDENCE}', '${TENANT_ID}', null, 'collection_gap', 'gitlab', '${RUN_ID}',
          'region skipped', '{}', 'architecture.discovery', now(), now() + interval '100 years')`,
    );
    await query(
      pg,
      `insert into "architecture"."discovery_draft"
         (id, tenant_id, run_id, base_version, state, opened_at)
       values ('${DRAFT_ID}', '${TENANT_ID}', '${RUN_ID}', 0, 'open', now())`,
    );

    // graph_node: a resolving reference, a null (human) reference, a reference to a real
    // `mark_removed`-shaped absence row, and a broken reference naming a real evidence row of
    // the wrong type.
    await query(
      pg,
      `insert into "architecture"."graph_node"
         (id, tenant_id, node_kind, layer, name, natural_key, provenance, strength, confidence,
          state, observation_ref, actor_ref, valid_from_version, valid_to_version)
       values
         ('${NODE_OK}', '${TENANT_ID}', 'component', 'code', 'svc-ok', 'key-ok',
          'derived_from_code', 30, 60, 'proposed', '${GOOD_EVIDENCE}', null, 1, 2147483647),
         ('${NODE_HUMAN}', '${TENANT_ID}', 'component', 'code', 'svc-human', 'key-human',
          'human_confirmed', 70, 90, 'confirmed', null, 'pavlo', 1, 2147483647),
         ('${NODE_ABSENCE}', '${TENANT_ID}', 'component', 'code', 'svc-absence', 'key-absence',
          'derived_from_code', 30, 60, 'proposed', '${ABSENCE_EVIDENCE}', null, 1, 2147483647),
         ('${NODE_BROKEN}', '${TENANT_ID}', 'component', 'code', 'svc-broken', 'key-broken',
          'derived_from_code', 30, 60, 'proposed', '${WRONG_TYPE_EVIDENCE}', null, 1, 2147483647),
         ('${NODE_FROM}', '${TENANT_ID}', 'component', 'code', 'svc-from', 'key-from',
          'human_confirmed', 70, 90, 'confirmed', null, 'pavlo', 1, 2147483647),
         ('${NODE_TO}', '${TENANT_ID}', 'component', 'code', 'svc-to', 'key-to',
          'human_confirmed', 70, 90, 'confirmed', null, 'pavlo', 1, 2147483647)`,
    );

    // graph_edge + edge_provenance: one resolving, one broken (references a nonexistent id).
    const EDGE_PROVENANCE_OK = '00000000-0000-0000-0000-00000000d032';
    const EDGE_PROVENANCE_BROKEN = '00000000-0000-0000-0000-00000000d033';
    // Distinct `edge_type` per row — T009's partial unique index allows only one open row per
    // logical (tenant, from, to, edge_type, layer) tuple.
    const edgeCases: readonly [string, string, string, string][] = [
      [EDGE_OK, EDGE_PROVENANCE_OK, GOOD_EVIDENCE, 'depends_on'],
      [EDGE_BROKEN, EDGE_PROVENANCE_BROKEN, '00000000-0000-0000-0000-0000000000ff', 'calls'],
    ];
    for (const [edgeId, provenanceRowId, observationRef, edgeType] of edgeCases) {
      await query(
        pg,
        `insert into "architecture"."graph_edge"
           (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
            confidence, state, valid_from_version, valid_to_version, observation_ref)
         values ('${edgeId}', '${TENANT_ID}', '${NODE_FROM}', '${NODE_TO}', '${edgeType}', 'code',
                 'derived_from_code', 30, 60, 'proposed', 1, 2147483647, '${observationRef}')`,
      );
      await query(
        pg,
        `insert into "architecture"."edge_provenance"
           (id, tenant_id, edge_id, provenance, strength, confidence, observation_ref, adapter_key,
            adapter_version, valid_from_version)
         values ('${provenanceRowId}', '${TENANT_ID}', '${edgeId}', 'derived_from_code', 30, 60,
                 '${observationRef}', 'gitlab', '0.2.0', 1)`,
      );
    }

    // draft_item: a resolving reference and a broken one.
    await query(
      pg,
      `insert into "architecture"."draft_item"
         (id, tenant_id, draft_id, op, proposed, proposal_digest, provenance, strength, confidence,
          observation_ref, state)
       values
         ('${ITEM_OK}', '${TENANT_ID}', '${DRAFT_ID}', 'add_node', '{}', 'digest-ok',
          'derived_from_code', 30, 60, '${GOOD_EVIDENCE}', 'proposed'),
         ('${ITEM_BROKEN}', '${TENANT_ID}', '${DRAFT_ID}', 'add_node', '{}', 'digest-broken',
          'derived_from_code', 30, 60, '00000000-0000-0000-0000-0000000000fe', 'proposed')`,
    );

    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('flags only the three broken references, across all three tables, and never a resolving, null or absence one', async () => {
    const violations = await findUnresolvableObservationRefs(prisma);

    expect(violations.some((v) => v.includes('graph_node') && v.includes(NODE_BROKEN))).toBe(true);
    expect(violations.some((v) => v.includes('edge_provenance'))).toBe(true);
    expect(violations.some((v) => v.includes('draft_item') && v.includes(ITEM_BROKEN))).toBe(true);
    expect(violations).toHaveLength(3);

    expect(violations.some((v) => v.includes(NODE_OK))).toBe(false);
    expect(violations.some((v) => v.includes(NODE_HUMAN))).toBe(false);
    expect(violations.some((v) => v.includes(NODE_ABSENCE))).toBe(false);
    expect(violations.some((v) => v.includes(ITEM_OK))).toBe(false);
  });
});
