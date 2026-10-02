#!/usr/bin/env node
// `check:stale-approvals` (002 T076, SC-007, R-09): no `pending` approval request is past its
// `expires_at` without its deadline having fired, and none is parked in a way that no deadline
// could ever fire. Same posture as `check:policy-coverage` and `check:ceiling`: continuous
// reconciliation against the live database, not a release gate — `make ci` does not run it
// against production. What `make ci` does run (`test-e2e`) is `approval-lifecycle.e2e.test.ts`,
// which seeds each violation below and asserts this query reports it, and seeds a healthy
// request and a lapsed-then-expired one and asserts it does not. A check nobody runs is not a
// control: this one is wired as `npm run check:stale-approvals` and listed in quickstart.md's
// "Invariant checks"; scheduling it belongs to whatever runs the other four (no scheduler exists
// in this repository yet — QUESTIONS.md, "002 Phase 7").
//
// Three violation shapes, each a way "expiry always has a tick that will fire it" (data-model.md
// invariant) can be false:
//   1. overdue — pending, `expires_at` passed more than `graceMs` ago: the tick did not fire it.
//   2. unfireable — the run has no `deadline_at`, or one earlier than `expires_at`'s projection
//      allows (`expires_at` later than `deadline_at`): the projection (T073) was bypassed.
//   3. orphaned — the run is already terminal while the request is still pending: nothing will
//      ever resume it, and nothing expires it.
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

// How late a tick may be before it counts as missed. The tick cadence is not specified anywhere
// yet; five minutes is a placeholder, not a derived number (same status as every other unset
// value in 002 — data-model.md "placeholders until stage-0").
export const DEFAULT_GRACE_MS = 5 * 60 * 1000;

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @param {{ now?: Date, graceMs?: number }} [options]
 * @returns {Promise<string[]>} one message per violating `pending` approval request
 */
export async function findStaleApprovals(prisma, options = {}) {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.graceMs ?? DEFAULT_GRACE_MS));
  const rows = await prisma.$queryRaw`
    SELECT ar.id, ar.tenant_id, ar.expires_at, wr.deadline_at, wr.terminal_state,
           (ar.expires_at <= ${cutoff}) AS overdue,
           (wr.terminal_state IS NULL AND (wr.deadline_at IS NULL OR wr.deadline_at < ar.expires_at)) AS unfireable,
           (wr.terminal_state IS NOT NULL) AS orphaned
    FROM "policy"."approval_request" ar
    LEFT JOIN "workflow"."workflow_run" wr
      ON wr.id = ar.workflow_run_id AND wr.tenant_id = ar.tenant_id
    WHERE ar.state = 'pending'
      AND (ar.expires_at <= ${cutoff}
           OR wr.id IS NULL
           OR wr.terminal_state IS NOT NULL
           OR wr.deadline_at IS NULL
           OR wr.deadline_at < ar.expires_at)
    ORDER BY ar.expires_at
  `;
  return rows.map((row) => {
    const base = `approval_request ${row.id} (tenant ${row.tenant_id}, expires ${row.expires_at.toISOString()})`;
    const reasons = [];
    if (row.overdue) reasons.push('pending past expires_at: its deadline tick did not fire');
    if (row.orphaned) reasons.push(`its run is already terminal (${row.terminal_state})`);
    if (row.unfireable) {
      reasons.push('its run has no deadline at or after expires_at: no tick will ever fire it');
    }
    if (reasons.length === 0) reasons.push('its workflow run does not resolve under this tenant');
    return `${base}: ${reasons.join('; ')}`;
  });
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by approval-lifecycle.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:stale-approvals', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findStaleApprovals(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:stale-approvals: no pending approval request is past its expiry or unfireable\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
