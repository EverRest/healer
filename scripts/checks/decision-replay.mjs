#!/usr/bin/env node
// `check:decision-replay` (002 T030, FR-002, SC-002): samples stored `policy_decision` rows and
// replays each against its own recorded `decision_input` and `ruleset_version` — the *historical*
// rule set, never the tenant's current one — using the shared `replayDecision` query (batch 9 C2,
// review finding: this used to re-implement `resolveRulesetAndEvaluate`'s call into `evaluate()`
// by hand, which is how it missed the JSONB `evaluatedAt` coercion fix and would have needed its
// own copy of any future fix too — one implementation now, called from both the HTTP endpoint and
// here). A differing outcome is a production incident this check surfaces, not a test assertion
// (contracts/evaluation.md: "a differing outcome is an incident, not a test failure") — same
// posture as `check:evidence-coverage` and `check:expired-evidence`.
import {
  decisionInputSchema,
  PrismaPolicyRulesetRepository,
  replayDecision,
  RulesetVersionNotFoundError,
} from '@healer/domain-policy';
import { TenantContext } from '@healer/shared';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const DEFAULT_SAMPLE_SIZE = 200;

/** `data-model.md`'s Invariants: "`evaluate(ruleset_version, decision_input) = (outcome,
 *  matched_rule_keys)` replays identically" — both halves of the pair (batch 9 C2, review
 *  finding: comparing outcome alone would call two decisions identical even when a different set
 *  of rules matched to reach the same fold result). The outcome-mismatch message is worded to
 *  match what this check has always said for that case; the rule-key-only mismatch is new. */
function formatMismatch(row, replayed) {
  if (replayed.outcome !== row.outcome) {
    return `decision ${row.id}: recorded outcome "${row.outcome}", replay against ruleset version ${row.rulesetVersion} produced "${replayed.outcome}"`;
  }
  return (
    `decision ${row.id}: recorded matched rule keys ${JSON.stringify([...row.matchedRuleKeys].sort())}, ` +
    `replay against ruleset version ${row.rulesetVersion} produced ${JSON.stringify([...replayed.matchedRuleKeys].sort())} ` +
    `(same outcome "${row.outcome}")`
  );
}

/**
 * One decision replayed against its own resolved rule set, via the shared `replayDecision` query
 * — real I/O (a `ReadOnlyPolicyRulesetRepository`), so this is proven against a real Postgres in
 * `decision-replay.e2e.test.ts`; `decision-replay.test.ts` proves `formatMismatch` and the
 * ruleset-not-found path against a fake repository.
 * @param {import('@healer/domain-policy').ReadOnlyPolicyRulesetRepository} rulesets
 * @param {{ id: string, tenantId: string, decisionInput: unknown, rulesetVersion: number, outcome: string, matchedRuleKeys: readonly string[] }} row
 * @returns {Promise<string | null>} a violation message, or null when the replay agrees with history
 */
export async function replayOne(rulesets, row) {
  // Everything below — including the schema parse — is inside this try (batch 9 follow-up
  // review, both independent Opus reviews): a bare `.parse()` outside the try used to throw
  // uncaught on any non-conforming stored row, crashing the whole gate instead of reporting just
  // that row as a violation — exactly the "crashes instead of reporting the row" failure C2 was
  // about, recurring one layer up. Any error here becomes that row's own violation message, with
  // the row's id, so one bad row never hides the rest of the sample.
  try {
    const context = TenantContext.forTrustedInternalUse(row.tenantId);
    // This query reads `decision_input` straight off the row (not through
    // `PrismaPolicyDecisionRepository.findById`/`list`, which already parse it) — batch 9 C2's
    // reproduction: JSONB round-trips `evaluatedAt` as a string, and `evaluate()`'s instant
    // predicates call `.getTime()` on it. `decisionInputSchema` is the one place that coercion is
    // defined; every reader of stored `decision_input` parses through it rather than trusting the
    // raw cast.
    const decisionInput = decisionInputSchema.parse(row.decisionInput);
    const { identical, replayed } = await replayDecision({ rulesets }, context, {
      decisionInput,
      rulesetVersion: row.rulesetVersion,
      outcome: row.outcome,
      matchedRuleKeys: row.matchedRuleKeys,
    });
    return identical ? null : formatMismatch(row, replayed);
  } catch (error) {
    if (error instanceof RulesetVersionNotFoundError) {
      return `decision ${row.id}: ruleset version ${row.rulesetVersion} no longer resolves for its tenant (violates SC-003)`;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `decision ${row.id}: could not be replayed — ${message}`;
  }
}

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @param {number} sampleSize
 */
export async function findReplayMismatches(prisma, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const rulesets = new PrismaPolicyRulesetRepository(prisma);
  const rows = await prisma.policyDecision.findMany({
    // A lapse (`ExpireApproval`, 002 T072) is *recorded*, not evaluated: it carries no matched
    // rule and the one reason `APPROVAL_EXPIRED`, and no ruleset could reproduce it from its
    // input (which is the require-approval decision's own). Excluded by that shape, not by reason
    // code alone — a rule whose `reasonCode` is `APPROVAL_EXPIRED` matches a rule key and still
    // replays.
    where: {
      NOT: {
        AND: [{ reasonCodes: { has: 'APPROVAL_EXPIRED' } }, { matchedRuleKeys: { isEmpty: true } }],
      },
    },
    take: sampleSize,
    orderBy: { evaluatedAt: 'desc' },
    select: {
      id: true,
      tenantId: true,
      decisionInput: true,
      rulesetVersion: true,
      outcome: true,
      matchedRuleKeys: true,
    },
  });

  const violations = [];
  for (const row of rows) {
    const violation = await replayOne(rulesets, row);
    if (violation !== null) violations.push(violation);
  }
  return violations;
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by decision-replay.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:decision-replay', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findReplayMismatches(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write('check:decision-replay: sampled decisions replay identically\n');
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
