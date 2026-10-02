#!/usr/bin/env node
// `check:graph-fact-coverage` (004 T035, FR-027, FR-006, SC-001, 001 FR-007, 001 FR-008) — same
// family and posture as `check:evidence-coverage`: every non-null `observation_ref` across the
// three places the graph carries one must resolve to a real `evidence` row of
// `type = 'graph_fact'`. `graph_node.observation_ref`'s own column comment in `schema.prisma`
// names this exact check as its continuous counterpart.
//
// Three tables, one shape (`graph_node`, `edge_provenance`, `draft_item`), each tenant-scoped —
// the same `el.tenant_id = c.tenant_id` discipline `check:evidence-coverage`'s own header explains
// (a reference naming a real evidence id under the *wrong* tenant must still count as a
// violation, never as accidental coverage).
//
// A `null` `observation_ref` is never checked here, by construction — a human-authored/confirmed
// row carries no observation (FR-007's own two human provenance classes have no discovery
// observation to point at; `confirm-draft-items.ts`'s `applyDecision` never sets one). This is not
// a gap `mark_removed`'s synthetic "absence" `graph_fact` rows fall through either: A1's own
// judgment call (QUESTIONS.md "004 Phase 3 — discovery run and draft (A1)") stamps every
// `mark_removed` item with a real, non-null `observation_ref` pointing at a synthetic absence
// evidence row whose `type` is `'graph_fact'` (`prisma-discovery-repository.ts`'s `ingestBatch`:
// `where.absenceEvidence` rows are inserted with `type: 'graph_fact'`, same as every positively-
// observed shape) — verified against that file before writing this query, per this task's own
// instruction not to assume a different type for it.
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const GRAPH_FACT_TYPE = 'graph_fact';

const TABLES = [
  { schema: 'architecture', table: 'graph_node', column: 'observation_ref' },
  { schema: 'architecture', table: 'edge_provenance', column: 'observation_ref' },
  { schema: 'architecture', table: 'draft_item', column: 'observation_ref' },
];

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @returns {Promise<string[]>}
 */
export async function findUnresolvableObservationRefs(prisma) {
  const violations = [];
  for (const { schema, table, column } of TABLES) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT c.id, c.tenant_id, c."${column}" AS observation_ref
       FROM "${schema}"."${table}" c
       WHERE c."${column}" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "evidence"."evidence" e
           WHERE e.id = c."${column}" AND e.tenant_id = c.tenant_id
           AND e.type = $1::"evidence"."evidence_type"
         )`,
      GRAPH_FACT_TYPE,
    );
    for (const row of rows) {
      violations.push(
        `${schema}.${table} ${row.id} (tenant ${row.tenant_id}): ${column} ${row.observation_ref} ` +
          `does not resolve to an evidence row of type '${GRAPH_FACT_TYPE}'`,
      );
    }
  }
  return violations;
}

/* v8 ignore start -- CLI wiring; the query is proven by graph-fact-coverage.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:graph-fact-coverage', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findUnresolvableObservationRefs(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:graph-fact-coverage: every observation_ref resolves to a graph_fact evidence row\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
