#!/usr/bin/env node
// `check:graph-provenance` (004 T040, SC-001): continuous reconciliation against the live database —
// every graph node and edge carries a provenance class, strength and confidence, and a
// *resolvable* source: a machine node's `observation_ref` names an `evidence` row of the same
// tenant; a human node names an actor; a machine edge has at least one `edge_provenance` row and
// every such row's `observation_ref` resolves the same way.
//
// The column constraints (T006) already refuse a null at write time; this is the backstop for
// what a constraint cannot say — a reference that points at nothing — and for a constraint that a
// privileged write or a dropped migration has removed. Same posture as `check:ceiling`:
// production monitoring, not a release gate.
//
// A human-class edge is reported, not skipped: `graph_edge`/`edge_provenance` have no actor column
// (data-model.md), so nothing can name who authored it, and no code path creates one yet. When a
// human edge path exists this finding is the reminder that it needs somewhere to record the actor
// (QUESTIONS.md "Decisions waiting on Pavlo — 004" item 1).
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @returns {Promise<string[]>} one message per violation
 */
export async function findProvenanceViolations(prisma) {
  const nodes = await prisma.$queryRaw`
    SELECT n.id, n.tenant_id, n.provenance, n.strength, n.confidence, n.observation_ref, n.actor_ref,
           (n.observation_ref IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM "evidence"."evidence" ev
              WHERE ev.id = n.observation_ref AND ev.tenant_id = n.tenant_id)) AS dangling
    FROM "architecture"."graph_node" n`;
  const edges = await prisma.$queryRaw`
    SELECT e.id, e.tenant_id, e.provenance, e.strength, e.confidence,
           (SELECT count(*) FROM "architecture"."edge_provenance" p
              WHERE p.edge_id = e.id AND p.tenant_id = e.tenant_id) AS provenance_rows
    FROM "architecture"."graph_edge" e`;
  const rows = await prisma.$queryRaw`
    SELECT p.edge_id, p.tenant_id, p.observation_ref
    FROM "architecture"."edge_provenance" p
    WHERE p.observation_ref IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "evidence"."evidence" ev
      WHERE ev.id = p.observation_ref AND ev.tenant_id = p.tenant_id)`;

  const human = (p) => p === 'human_authored' || p === 'human_confirmed';
  const out = [];
  for (const n of nodes) {
    const who = `graph_node ${n.id} (tenant ${n.tenant_id})`;
    if (n.provenance === null || n.strength === null || n.confidence === null) {
      out.push(`${who}: provenance, strength or confidence is null`);
    } else if (human(n.provenance)) {
      if (n.actor_ref === null) out.push(`${who}: human provenance without a named actor`);
    } else if (n.observation_ref === null) {
      out.push(`${who}: machine provenance without an observation_ref`);
    } else if (n.dangling) {
      out.push(`${who}: observation_ref ${n.observation_ref} does not resolve to evidence`);
    }
  }
  for (const e of edges) {
    const who = `graph_edge ${e.id} (tenant ${e.tenant_id})`;
    if (e.provenance === null || e.strength === null || e.confidence === null) {
      out.push(`${who}: provenance, strength or confidence is null`);
    } else if (human(e.provenance)) {
      out.push(`${who}: human provenance but an edge has no actor reference`);
    } else if (Number(e.provenance_rows) === 0) {
      out.push(`${who}: no edge_provenance row`);
    }
  }
  for (const r of rows) {
    out.push(
      `graph_edge ${r.edge_id} (tenant ${r.tenant_id}): edge_provenance observation_ref ${r.observation_ref} does not resolve to evidence`,
    );
  }
  return out;
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by graph-checks.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:graph-provenance', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findProvenanceViolations(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:graph-provenance: every node and edge carries a resolvable source\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
