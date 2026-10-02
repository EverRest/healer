#!/usr/bin/env node
// `check:edge-strength-max` (004 T040, data-model invariant): an open `graph_edge`'s stored
// `strength` and `confidence` equal the maximum over its `edge_provenance` rows. They are
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
 * @returns {Promise<string[]>} one message per drifted edge
 */
export async function findStrengthMaxViolations(prisma) {
  const rows = await prisma.$queryRaw`
    SELECT e.id, e.tenant_id, e.strength, e.confidence, m.max_strength, m.max_confidence
    FROM "architecture"."graph_edge" e
    JOIN (
      SELECT tenant_id, edge_id, MAX(strength) AS max_strength, MAX(confidence) AS max_confidence
      FROM "architecture"."edge_provenance" GROUP BY tenant_id, edge_id
    ) m ON m.edge_id = e.id AND m.tenant_id = e.tenant_id
    WHERE e.valid_to_version = 2147483647
      AND (e.strength <> m.max_strength OR e.confidence <> m.max_confidence)`;
  return rows.map(
    (r) =>
      `graph_edge ${r.id} (tenant ${r.tenant_id}): stored strength ${r.strength} / confidence ${r.confidence}, ` +
      `max over edge_provenance is ${r.max_strength} / ${r.max_confidence}`,
  );
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by graph-checks.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:edge-strength-max', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findStrengthMaxViolations(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:edge-strength-max: every open edge equals the maximum over its provenance rows\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
