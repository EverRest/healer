#!/usr/bin/env node
// `check:confirmation-actors` (004 T034, SC-002, SC-003) — same family and same posture as
// `check:policy-coverage`/`check:evidence-coverage`: a continuous, independent-of-code-review
// proof that a structural guarantee actually holds in the data, not only in the handler that
// writes it. `requireHumanReviewActor` (`packages/domain/architecture/src/application/
// require-human-review-actor.ts`) already refuses a non-human confirm/reject before any write —
// this is the belt-and-suspenders counterpart, the one that would notice if some future caller
// ever bypassed that gate (a direct repository call, a migration script, a bug).
//
// `graph_audit_entry` does not exist as its own table — `graph-audit-entry.ts`'s own header
// comment says `NewGraphAuditEntry` mirrors `audit.audit_entry` locally rather than importing a
// second table; this check reads that same shared table. There is also no `outcome = 'confirmed'`
// value: `audit_entry.outcome` is a plain `'ok' | 'refused'` regardless of action — checked in
// `graph-audit-entry.ts` before writing this query, per this task's own instruction to verify
// against the real column rather than the value named in the task description.
//
// Two violation shapes, both covering SC-002 ("0 confirmations by a non-human actor") and SC-003
// ("0 rows in state = 'confirmed' written by a discovery run" — discovery's own write path
// (`ingest-discovery-batch.ts`) only ever writes `state: 'proposed'`; the only way a `draft_item`
// reaches `confirmed` is the audited `architecture.draft_item.confirm` path, so a confirmed item
// with no matching human-actor audit entry is exactly SC-003's violation, not a separate query):
//
//  1. An `audit_entry` row for `architecture.draft_item.confirm`, outcome `ok`, whose actor is not
//     human — if this is ever non-empty, the structural gate was bypassed and it actually happened.
//  2. A `draft_item` with `state = 'confirmed'` whose confirming audit trail (joined via the
//     resulting `graph_node`/`graph_edge` id `confirmDraftItems` backfills onto `target_node_id`/
//     `target_edge_id`) either does not exist or names a non-human actor — the same LEFT-join
//     "missing is itself a violation" shape `check:policy-coverage`'s own header explains (an
//     absent link is at least as alarming as a wrong one, never silently passed).
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const CONFIRM_ACTION = 'architecture.draft_item.confirm';

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @returns {Promise<string[]>}
 */
export async function findNonHumanConfirmations(prisma) {
  const violations = [];

  const directRows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, actor_type, actor_ref, target_id
     FROM "audit"."audit_entry"
     WHERE action = $1 AND outcome = 'ok' AND actor_type <> 'human'`,
    CONFIRM_ACTION,
  );
  for (const row of directRows) {
    violations.push(
      `audit_entry ${row.id} (tenant ${row.tenant_id}): ${CONFIRM_ACTION} succeeded for ` +
        `actor_type '${row.actor_type}' (actor_ref ${row.actor_ref}), target ${row.target_id} — SC-002`,
    );
  }

  const draftRows = await prisma.$queryRawUnsafe(
    `SELECT di.id, di.tenant_id, di.decided_by, ae.actor_type
     FROM "architecture"."draft_item" di
     LEFT JOIN "audit"."audit_entry" ae
       ON ae.tenant_id = di.tenant_id
      AND ae.action = $1
      AND ae.outcome = 'ok'
      AND ae.target_id = COALESCE(di.target_node_id, di.target_edge_id)
     WHERE di.state = 'confirmed'
       AND (ae.id IS NULL OR ae.actor_type <> 'human')`,
    CONFIRM_ACTION,
  );
  for (const row of draftRows) {
    const reason =
      row.actor_type === null || row.actor_type === undefined
        ? 'no matching human-actor audit entry'
        : `matching audit entry's actor_type is '${row.actor_type}', not 'human'`;
    violations.push(
      `draft_item ${row.id} (tenant ${row.tenant_id}, decided_by ${row.decided_by}): ` +
        `state = 'confirmed' but ${reason} — SC-003`,
    );
  }

  return violations;
}

/* v8 ignore start -- CLI wiring; the query is proven by confirmation-actors.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:confirmation-actors', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findNonHumanConfirmations(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:confirmation-actors: every confirmed draft item traces to a human actor\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
