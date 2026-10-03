#!/usr/bin/env node
// `check:edge-strength-max` (004 T040, data-model invariant): an open `graph_edge`'s stored
// `strength` and `confidence` equal the maximum over its `edge_provenance` rows, its
// `observation_count` their SUM, its `last_observed_at` their MAX and its `provenance` class the
// strongest row's (ties: earliest recorded, then id). They are
// denormalised so a traversal stays a single self-join (R-01); this is the check that the
// denormalisation has not drifted — a write that skipped the maintenance trigger, a privileged
// correction, a bug in the merge path.
//
// Open rows only (`valid_to_version = 2147483647`): the trigger deliberately never touches a
// closed row (a pinned query must see it as it was), so a closed edge legitimately stops tracking
// rows added later. An edge with no provenance row has no maximum to compare against; that is
// `check:graph-provenance`'s finding, not this one's.
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @returns {Promise<{ violations: string[], checked: { edges: number } }>}
 */
export async function findStrengthMaxViolations(prisma) {
  const rows = await prisma.$queryRaw`
    SELECT e.id, e.tenant_id, e.strength, e.confidence, e.observation_count, e.last_observed_at,
           e.provenance::text AS provenance,
           m.max_strength, m.max_confidence, m.sum_count, m.max_last, m.strongest_class
    FROM "architecture"."graph_edge" e
    JOIN (
      SELECT tenant_id, edge_id, MAX(strength) AS max_strength, MAX(confidence) AS max_confidence,
             SUM(observation_count) AS sum_count, MAX(last_observed_at) AS max_last,
             (array_agg(provenance::text ORDER BY strength DESC, recorded_at ASC, id ASC))[1]
               AS strongest_class
      FROM "architecture"."edge_provenance" GROUP BY tenant_id, edge_id
    ) m ON m.edge_id = e.id AND m.tenant_id = e.tenant_id
    WHERE e.valid_to_version = 2147483647`;
  const out = [];
  for (const r of rows) {
    const who = `graph_edge ${r.id} (tenant ${r.tenant_id})`;
    if (r.strength !== r.max_strength || r.confidence !== r.max_confidence) {
      out.push(
        `${who}: stored strength ${r.strength} / confidence ${r.confidence}, ` +
          `max over edge_provenance is ${r.max_strength} / ${r.max_confidence}`,
      );
    }
    if (Number(r.observation_count) !== Number(r.sum_count)) {
      out.push(
        `${who}: observation_count ${r.observation_count}, sum over edge_provenance is ${r.sum_count}`,
      );
    }
    const stored = r.last_observed_at?.getTime() ?? null;
    const max = r.max_last?.getTime() ?? null;
    if (stored !== max) {
      out.push(
        `${who}: last_observed_at ${r.last_observed_at?.toISOString() ?? 'null'}, ` +
          `max over edge_provenance is ${r.max_last?.toISOString() ?? 'null'}`,
      );
    }
    if (r.provenance !== r.strongest_class) {
      out.push(
        `${who}: provenance ${r.provenance}, strongest edge_provenance row is ${r.strongest_class}`,
      );
    }
  }
  return { violations: out, checked: { edges: rows.length } };
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by graph-checks.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:edge-strength-max', async () => {
    const prisma = new PrismaClient();
    try {
      const { violations, checked } = await findStrengthMaxViolations(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        `check:edge-strength-max: checked ${checked.edges} open edges, each equals the aggregate over its provenance rows\n`,
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
