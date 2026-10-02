import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { findStrengthMaxViolations } from './edge-strength-max.mjs';
import { findProvenanceViolations } from './graph-provenance.mjs';

/**
 * `check:graph-provenance` (004 T040, SC-001) and `check:edge-strength-max` (T040, data-model
 * invariant) against a real Postgres. Each case that must find something first seeds clean data and
 * proves the check says nothing, then breaks exactly one guarantee.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const TENANT = '00000000-0000-0000-8000-00000000c040';
const OTHER = '00000000-0000-0000-8000-00000000d040';
const ISSUE = '00000000-0000-0000-8000-00000000e040';
const OTHER_ISSUE = '00000000-0000-0000-8000-00000000f040';

describe('graph continuous checks against a real Postgres (004 T040)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  const sql = (text: string) => query(pg, text);

  async function evidence(tenant = TENANT): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into "evidence"."evidence"
         (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
          produced_by_step, observed_at, expires_at)
       values ('${id}', '${tenant}', '${tenant === TENANT ? ISSUE : OTHER_ISSUE}', 'graph_fact', 'discovery', 'r', 'fact', '{}',
               'discovery', now(), now() + interval '30 days')`,
    );
    return id;
  }

  async function node(provenance: string, ref: string | null, actor: string | null = null) {
    const id = randomUUID();
    await sql(
      `insert into "architecture"."graph_node"
         (id, tenant_id, node_kind, layer, name, natural_key, provenance, strength, confidence,
          state, observation_ref, actor_ref, valid_from_version)
       values ('${id}', '${TENANT}', 'component', 'code', 'n', '${id}', '${provenance}', 30, 50,
               'proposed', ${ref === null ? 'null' : `'${ref}'`},
               ${actor === null ? 'null' : `'${actor}'`}, 1)`,
    );
    return id;
  }

  async function edge(from: string, to: string, provenance = 'derived_from_code') {
    const id = randomUUID();
    await sql(
      `insert into "architecture"."graph_edge"
         (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
          confidence, state, valid_from_version)
       values ('${id}', '${TENANT}', '${from}', '${to}', 'depends_on', 'code', '${provenance}',
               30, 50, 'proposed', 1)`,
    );
    return id;
  }

  async function provenanceRow(edgeId: string, strength: number, confidence: number, ref: string) {
    await sql(
      `insert into "architecture"."edge_provenance"
         (id, tenant_id, edge_id, provenance, strength, confidence, observation_ref, adapter_key,
          adapter_version)
       values ('${randomUUID()}', '${TENANT}', '${edgeId}', 'derived_from_code', ${strength},
               ${confidence}, '${ref}', 'ast', '1')`,
    );
  }

  beforeAll(async () => {
    pg = await startPostgres();
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${entry}/migration.sql`);
    }
    await sql(`insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`);
    await sql(
      `insert into "issue"."issue"
         (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
          occurrence_count, first_seen_at, last_seen_at)
       values ('${ISSUE}', '${TENANT}', 'production_incident', 'prod', 'high', 'detected', 'fp', 1,
               1, now(), now())`,
    );
    await sql(
      `insert into "issue"."issue"
         (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
          occurrence_count, first_seen_at, last_seen_at)
       values ('${OTHER_ISSUE}', '${OTHER}', 'production_incident', 'prod', 'high', 'detected', 'fp2',
               1, 1, now(), now())`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  describe('check:graph-provenance (SC-001)', () => {
    it('finds nothing in a graph whose every element resolves', async () => {
      const ev = await evidence();
      const [a, b] = [
        await node('derived_from_code', ev),
        await node('human_authored', null, 'ana'),
      ];
      await provenanceRow(await edge(a, b), 30, 50, await evidence());
      expect(await findProvenanceViolations(prisma)).toEqual([]);
    });

    it('flags a node whose observation is not an evidence row', async () => {
      const ghost = randomUUID();
      const id = await node('derived_from_trace', ghost);
      expect(await findProvenanceViolations(prisma)).toContain(
        `graph_node ${id} (tenant ${TENANT}): observation_ref ${ghost} does not resolve to evidence`,
      );
    });

    it('flags an observation that exists only under another tenant', async () => {
      const foreign = await evidence(OTHER);
      const id = await node('derived_from_trace', foreign);
      expect(await findProvenanceViolations(prisma)).toContain(
        `graph_node ${id} (tenant ${TENANT}): observation_ref ${foreign} does not resolve to evidence`,
      );
    });

    it('flags a machine edge with no edge_provenance row, and an unresolvable one', async () => {
      const [a, b] = [
        await node('derived_from_code', await evidence()),
        await node('derived_from_code', await evidence()),
      ];
      const bare = await edge(a, b, 'derived_from_trace');
      const ghost = randomUUID();
      const dangling = await edge(b, a);
      await provenanceRow(dangling, 30, 50, ghost);
      const found = await findProvenanceViolations(prisma);
      expect(found).toContain(`graph_edge ${bare} (tenant ${TENANT}): no edge_provenance row`);
      expect(found).toContain(
        `graph_edge ${dangling} (tenant ${TENANT}): edge_provenance observation_ref ${ghost} does not resolve to evidence`,
      );
    });

    it('flags a human-class edge: no actor can be recorded on an edge', async () => {
      const [a, b] = [
        await node('derived_from_code', await evidence()),
        await node('derived_from_code', await evidence()),
      ];
      const human = await edge(a, b, 'human_authored');
      expect(await findProvenanceViolations(prisma)).toContain(
        `graph_edge ${human} (tenant ${TENANT}): human provenance but an edge has no actor reference`,
      );
    });
  });

  describe('check:edge-strength-max', () => {
    it('finds nothing when stored values equal the max over provenance rows', async () => {
      const [a, b] = [
        await node('derived_from_code', await evidence()),
        await node('derived_from_code', await evidence()),
      ];
      const id = await edge(a, b);
      await provenanceRow(id, 30, 60, await evidence());
      await provenanceRow(id, 50, 40, await evidence());
      expect(await findStrengthMaxViolations(prisma)).not.toEqual(
        expect.arrayContaining([expect.stringContaining(id)]),
      );
    });

    it('catches an edge whose stored strength/confidence drifted from the max', async () => {
      const [a, b] = [
        await node('derived_from_code', await evidence()),
        await node('derived_from_code', await evidence()),
      ];
      const id = await edge(a, b);
      // A write that skipped the maintenance trigger — exactly the drift the check exists for.
      await sql(
        `alter table "architecture"."edge_provenance" disable trigger edge_provenance_maintain_edge_max`,
      );
      try {
        await provenanceRow(id, 50, 90, await evidence());
      } finally {
        await sql(
          `alter table "architecture"."edge_provenance" enable trigger edge_provenance_maintain_edge_max`,
        );
      }
      expect(await findStrengthMaxViolations(prisma)).toContain(
        `graph_edge ${id} (tenant ${TENANT}): stored strength 30 / confidence 50, max over edge_provenance is 50 / 90`,
      );
    });
  });
});
