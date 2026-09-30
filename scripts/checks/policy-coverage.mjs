#!/usr/bin/env node
// `check:policy-coverage` (002 T031, SC-001, R-14): every *executed mutating action* must have
// exactly one consumed `ALLOW` decision behind it — the bypass a code review could miss, because
// "we checked that no caller skips the evaluator" is a review claim that decays with every new
// caller (R-14's own rationale). This is `audit_entry` (001 FR-012, every write this product
// performs writes one) left-joined to `policy_decision` on `(tenant_id, action, target_id)`; a row
// surviving the join with no matching consumed `ALLOW` is the alarm.
//
// The join has a key because `audit_entry.action` **is** a registered `policy_action.action_key`,
// not free text (prisma/schema.prisma's own comment on the column), and `policy_action.mutating`
// is what selects the rows that are supposed to have a decision at all — a read-only action never
// needs one. `policy_decision` has no `target_id` column of its own; its equivalent is
// `target_ref` (`decisionInput.target.targetRef`, TEXT, contracts/evaluation.md), so the join
// casts `audit_entry.target_id` (uuid) to text to compare against it.
//
// SC-001: "a row with no consumed ALLOW raises an alarm in production, not a test failure at
// release time" — designed to run continuously (a cron/monitoring job later, out of scope here),
// same posture as `check:evidence-coverage` and `check:decision-replay`.
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @returns {Promise<string[]>} one message per audit_entry with no consumed ALLOW behind it
 */
export async function findUncoveredMutatingActions(prisma) {
  const rows = await prisma.$queryRaw`
    SELECT ae.id, ae.tenant_id, ae.action, ae.target_id, ae.occurred_at
    FROM "audit"."audit_entry" ae
    JOIN "policy"."policy_action" pa ON pa.action_key = ae.action
    WHERE pa.mutating = true
      AND NOT EXISTS (
        SELECT 1 FROM "policy"."policy_decision" pd
        WHERE pd.tenant_id = ae.tenant_id
          AND pd.action_key = ae.action
          AND pd.target_ref = ae.target_id::text
          AND pd.outcome = 'allow'
          AND pd.consumed_at IS NOT NULL
      )
  `;
  return rows.map(
    (row) =>
      `audit_entry ${row.id} (tenant ${row.tenant_id}, action ${row.action}, target ${row.target_id}, ` +
      `occurred ${row.occurred_at.toISOString()}): no consumed ALLOW decision`,
  );
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by policy-coverage.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:policy-coverage', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findUncoveredMutatingActions(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:policy-coverage: every executed mutating action has a consumed ALLOW decision\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
