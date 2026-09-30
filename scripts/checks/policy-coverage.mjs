#!/usr/bin/env node
// `check:policy-coverage` (002 T031, SC-001, R-14): every *executed mutating action* must have
// exactly one consumed `ALLOW` decision behind it — the bypass a code review could miss, because
// "we checked that no caller skips the evaluator" is a review claim that decays with every new
// caller (R-14's own rationale). SC-001: "a row with no consumed ALLOW raises an alarm in
// production, not a test failure at release time" — designed to run continuously (a cron/
// monitoring job later, out of scope here), same posture as `check:evidence-coverage` and
// `check:decision-replay`.
//
// Two review findings shaped this query, both worth keeping visible here rather than only in the
// commit message:
//
// 1. (CRITICAL) An INNER join from `audit_entry` to `policy_action` drops any row whose `action`
//    string has no matching `policy_action` row *before* the mutating/coverage checks ever run —
//    silently escaping the exact "new caller nobody registered" bypass this check exists to catch,
//    one step earlier than the check could see it. `audit_entry.action` is documented as "a
//    registered `policy_action.action_key`, never free text" (prisma/schema.prisma) but that is
//    aspirational, not FK/CHECK-enforced, and it is already violated by real callers today —
//    `close-issue.ts`'s `CLOSE_AUDIT_ACTION = 'issue.close'` and `prisma-evidence-retention-
//    repository.ts`'s `PURGE_ACTION = 'evidence.retention_purge'` are both source-commented as not
//    yet registered. So `policy_action` is a LEFT join, and an unregistered action is reported as
//    its own violation category — you cannot know an unregistered action is read-only, so absence
//    from the registry is at least as alarming as presence-without-a-decision.
//
// 2. (HIGH/MEDIUM, one fix) Matching a decision by `(tenant_id, action_key, target_ref ==
//    target_id::text)` can neither verify the Invariants section's `proposal_digest` requirement
//    (`audit_entry` has no digest column to check it against) nor trust the cast (`target_ref` is
//    free text, not guaranteed UUID-shaped, and no real writer proves the cast today — the 008/010
//    executor that would doesn't exist yet). `audit_entry.policy_decision_id` already exists for
//    exactly this (`record-audit-entry.ts`/`prisma-audit-repository.ts` set it at write time), and
//    matching on it sidesteps the cast entirely — plus `ConsumeDecision` (T023) already enforces
//    digest-match as a precondition of setting `consumed_at`, so "linked decision is a consumed
//    ALLOW" transitively carries the digest-match guarantee forward with no new column needed.
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @returns {Promise<string[]>} one message per violation: an unregistered action key, or a
 *   registered mutating action with no consumed ALLOW decision linked
 */
export async function findUncoveredMutatingActions(prisma) {
  const rows = await prisma.$queryRaw`
    SELECT ae.id, ae.tenant_id, ae.action, ae.target_id, ae.occurred_at,
           (pa.action_key IS NULL) AS unregistered
    FROM "audit"."audit_entry" ae
    LEFT JOIN "policy"."policy_action" pa ON pa.action_key = ae.action
    LEFT JOIN "policy"."policy_decision" pd
      ON pd.id = ae.policy_decision_id
     AND pd.outcome = 'allow'
     AND pd.consumed_at IS NOT NULL
    WHERE pa.action_key IS NULL
       OR (pa.mutating = true AND pd.id IS NULL)
  `;
  return rows.map((row) => {
    const base =
      `audit_entry ${row.id} (tenant ${row.tenant_id}, action ${row.action}, ` +
      `target ${row.target_id}, occurred ${row.occurred_at.toISOString()})`;
    return row.unregistered
      ? `${base}: action is not a registered policy_action.action_key — cannot determine whether it needs a decision`
      : `${base}: no consumed ALLOW decision linked via policy_decision_id`;
  });
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
