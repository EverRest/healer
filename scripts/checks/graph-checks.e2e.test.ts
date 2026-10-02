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
 * invariant) against a real Postgres. Every case owns a tenant and asserts only on messages that
 * name it, so the cases do not depend on each other's rows or on their order. Each case that must
 * find something first proves the check says nothing about the clean tenant, then breaks exactly
 * one guarantee.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

describe('graph continuous checks against a real Postgres (004 T040)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  const sql = (text: string) => query(pg, text);

  /** A tenant with one issue, so it can own `graph_fact` evidence rows. */
  async function tenant(): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into "issue"."issue"
         (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
          occurrence_count, first_seen_at, last_seen_at)
       values ('${randomUUID()}', '${id}', 'production_incident', 'prod', 'high', 'detected',
               'fp', 1, 1, now(), now())`,
    );
    return id;
  }

  async function evidence(t: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into "evidence"."evidence"
         (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
          produced_by_step, observed_at, expires_at)
       values ('${id}', '${t}', (select id from "issue"."issue" where tenant_id = '${t}' limit 1),
               'graph_fact', 'discovery', 'r', 'fact', '{}', 'discovery', now(),
               now() + interval '30 days')`,
    );
    return id;
  }

  async function node(t: string, provenance: string, ref: string | null, actor?: string) {
    const id = randomUUID();
    await sql(
      `insert into "architecture"."graph_node"
         (id, tenant_id, node_kind, layer, name, natural_key, provenance, strength, confidence,
          state, observation_ref, actor_ref, valid_from_version)
       values ('${id}', '${t}', 'component', 'code', 'n', '${id}', '${provenance}', 30, 50,
               'proposed', ${ref === null ? 'null' : `'${ref}'`},
               ${actor === undefined ? 'null' : `'${actor}'`}, 1)`,
    );
    return id;
  }

  async function edge(t: string, from: string, to: string, provenance = 'derived_from_code') {
    const id = randomUUID();
    await sql(
      `insert into "architecture"."graph_edge"
         (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
          confidence, state, valid_from_version)
       values ('${id}', '${t}', '${from}', '${to}', 'depends_on', 'code', '${provenance}',
               30, 50, 'proposed', 1)`,
    );
    return id;
  }

  async function row(
    t: string,
    edgeId: string,
    over: {
      strength?: number;
      confidence?: number;
      ref?: string | null;
      provenance?: string;
      count?: number;
      last?: string;
    } = {},
  ) {
    const ref = over.ref === undefined ? await evidence(t) : over.ref;
    await sql(
      `insert into "architecture"."edge_provenance"
         (id, tenant_id, edge_id, provenance, strength, confidence, observation_ref, adapter_key,
          adapter_version, observation_count, last_observed_at)
       values ('${randomUUID()}', '${t}', '${edgeId}', '${over.provenance ?? 'derived_from_code'}',
               ${over.strength ?? 30}, ${over.confidence ?? 50},
               ${ref === null ? 'null' : `'${ref}'`}, 'ast', '1', ${over.count ?? 0},
               ${over.last === undefined ? 'null' : `'${over.last}'`})`,
    );
  }

  /** One clean machine edge between two evidenced nodes. */
  async function cleanEdge(t: string) {
    const a = await node(t, 'derived_from_code', await evidence(t));
    const b = await node(t, 'derived_from_code', await evidence(t));
    const e = await edge(t, a, b);
    await row(t, e);
    return { a, b, e };
  }

  const about = (violations: string[], t: string) => violations.filter((v) => v.includes(t));

  beforeAll(async () => {
    pg = await startPostgres();
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${entry}/migration.sql`);
    }
    await sql(`insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`);
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  describe('check:graph-provenance (SC-001)', () => {
    it('finds nothing in a graph whose every element resolves, and reports what it checked', async () => {
      const t = await tenant();
      const { a } = await cleanEdge(t);
      await node(t, 'human_authored', null, 'ana');
      const { violations, checked } = await findProvenanceViolations(prisma);
      expect(about(violations, t)).toEqual([]);
      expect(a).toBeDefined();
      expect(checked.nodes).toBeGreaterThanOrEqual(3);
      expect(checked.edges).toBeGreaterThanOrEqual(1);
    });

    it('flags a node whose observation is not an evidence row', async () => {
      const t = await tenant();
      const ghost = randomUUID();
      const id = await node(t, 'derived_from_trace', ghost);
      expect((await findProvenanceViolations(prisma)).violations).toContain(
        `graph_node ${id} (tenant ${t}): observation_ref ${ghost} does not resolve to evidence`,
      );
    });

    it('flags an observation that exists only under another tenant', async () => {
      const [t, other] = [await tenant(), await tenant()];
      const foreign = await evidence(other);
      const id = await node(t, 'derived_from_trace', foreign);
      expect((await findProvenanceViolations(prisma)).violations).toContain(
        `graph_node ${id} (tenant ${t}): observation_ref ${foreign} does not resolve to evidence`,
      );
    });

    it('flags a machine edge with no edge_provenance row, and an unresolvable one', async () => {
      const t = await tenant();
      const [a, b] = [
        await node(t, 'derived_from_code', await evidence(t)),
        await node(t, 'derived_from_code', await evidence(t)),
      ];
      const bare = await edge(t, a, b, 'derived_from_trace');
      const ghost = randomUUID();
      const dangling = await edge(t, b, a);
      await row(t, dangling, { ref: ghost });
      const { violations } = await findProvenanceViolations(prisma);
      expect(violations).toContain(`graph_edge ${bare} (tenant ${t}): no edge_provenance row`);
      expect(violations).toContain(
        `graph_edge ${dangling} (tenant ${t}): edge_provenance observation_ref ${ghost} does not resolve to evidence`,
      );
    });

    it('flags a human-class edge: no actor can be recorded on an edge', async () => {
      const t = await tenant();
      const [a, b] = [
        await node(t, 'derived_from_code', await evidence(t)),
        await node(t, 'derived_from_code', await evidence(t)),
      ];
      const human = await edge(t, a, b, 'human_authored');
      expect((await findProvenanceViolations(prisma)).violations).toContain(
        `graph_edge ${human} (tenant ${t}): human provenance but an edge has no actor reference`,
      );
    });

    it('flags a human-class edge_provenance row: it has no observation and no actor', async () => {
      const t = await tenant();
      const { e } = await cleanEdge(t);
      await row(t, e, { provenance: 'human_confirmed', ref: null });
      const found = about((await findProvenanceViolations(prisma)).violations, t);
      expect(found).toEqual([
        expect.stringContaining(
          `graph_edge ${e} (tenant ${t}): edge_provenance row has human provenance or no observation_ref`,
        ),
      ]);
    });
  });

  describe('check:edge-strength-max', () => {
    it('finds nothing when every stored value follows its provenance rows, and reports what it checked', async () => {
      const t = await tenant();
      const { a, b } = await cleanEdge(t);
      const id = await edge(t, b, a, 'derived_from_trace');
      await row(t, id, {
        provenance: 'derived_from_code',
        strength: 30,
        confidence: 60,
        count: 4,
        last: '2026-10-01T00:00:00Z',
      });
      await row(t, id, {
        provenance: 'derived_from_trace',
        strength: 50,
        confidence: 40,
        count: 6,
        last: '2026-10-02T00:00:00Z',
      });
      await sql(
        `update "architecture"."graph_edge" set observation_count = 10,
           last_observed_at = '2026-10-02T00:00:00Z' where id = '${id}'`,
      );
      const { violations, checked } = await findStrengthMaxViolations(prisma);
      expect(about(violations, t)).toEqual([]);
      expect(checked.edges).toBeGreaterThanOrEqual(2);
    });

    it('catches an edge whose stored strength/confidence drifted from the max', async () => {
      const t = await tenant();
      const { a, b } = await cleanEdge(t);
      const id = await edge(t, b, a, 'derived_from_code');
      await sql(
        `alter table "architecture"."edge_provenance" disable trigger edge_provenance_maintain_edge_max`,
      );
      try {
        await row(t, id, { strength: 50, confidence: 90, provenance: 'derived_from_trace' });
      } finally {
        await sql(
          `alter table "architecture"."edge_provenance" enable trigger edge_provenance_maintain_edge_max`,
        );
      }
      expect((await findStrengthMaxViolations(prisma)).violations).toContain(
        `graph_edge ${id} (tenant ${t}): stored strength 30 / confidence 50, max over edge_provenance is 50 / 90`,
      );
    });

    it('catches a drifted observation_count and last_observed_at', async () => {
      const t = await tenant();
      const { a, b } = await cleanEdge(t);
      const id = await edge(t, b, a);
      await row(t, id, { count: 5, last: '2026-10-01T00:00:00Z' });
      await sql(
        `update "architecture"."graph_edge" set observation_count = 99,
           last_observed_at = '2026-01-01T00:00:00Z' where id = '${id}'`,
      );
      const found = about((await findStrengthMaxViolations(prisma)).violations, t);
      expect(found).toContainEqual(
        expect.stringContaining(
          `graph_edge ${id} (tenant ${t}): observation_count 99, sum over edge_provenance is 5`,
        ),
      );
      expect(found).toContainEqual(
        expect.stringContaining(`graph_edge ${id} (tenant ${t}): last_observed_at`),
      );
    });

    it("catches an edge whose class is not the strongest row's", async () => {
      const t = await tenant();
      const { a, b } = await cleanEdge(t);
      const id = await edge(t, b, a, 'inferred_from_convention');
      await row(t, id, { provenance: 'derived_from_trace', strength: 50, confidence: 50 });
      // the maintenance trigger fixed strength/confidence; the class column is the merge path's
      expect(about((await findStrengthMaxViolations(prisma)).violations, t)).toContainEqual(
        expect.stringContaining(
          `graph_edge ${id} (tenant ${t}): provenance inferred_from_convention, strongest edge_provenance row is derived_from_trace`,
        ),
      );
    });
  });
});
