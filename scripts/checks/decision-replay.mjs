#!/usr/bin/env node
// `check:decision-replay` (002 T030, FR-002, SC-002): samples stored `policy_decision` rows and
// replays each against its own recorded `decision_input` and `ruleset_version` — the *historical*
// rule set, never the tenant's current one — using the same pure `evaluate()` the enforcing path
// and `ExplainDecision` both call. A differing outcome is a production incident this check
// surfaces, not a test assertion (contracts/evaluation.md: "a differing outcome is an incident,
// not a test failure") — same posture as `check:evidence-coverage` and `check:expired-evidence`.
import { evaluate } from '@healer/domain-policy';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const DEFAULT_SAMPLE_SIZE = 200;

/**
 * One decision replayed against one resolved rule set — pure, no I/O, so it is unit-testable on
 * its own (`decision-replay.test.ts`) without a database.
 * @param {{ id: string, decisionInput: unknown, rulesetVersion: number, outcome: string }} row
 * @param {{ version: number, rules: { ruleKey: string, predicates: unknown, outcome: string, reasonCode: string }[] } | null} ruleset
 * @returns {string | null} a violation message, or null when the replay agrees with history
 */
export function replayOne(row, ruleset) {
  if (ruleset === null) {
    return `decision ${row.id}: ruleset version ${row.rulesetVersion} no longer resolves for its tenant (violates SC-003)`;
  }
  const { decision } = evaluate(
    { version: ruleset.version, rules: ruleset.rules },
    row.decisionInput,
  );
  if (decision.outcome !== row.outcome) {
    return `decision ${row.id}: recorded outcome "${row.outcome}", replay against ruleset version ${row.rulesetVersion} produced "${decision.outcome}"`;
  }
  return null;
}

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @param {number} sampleSize
 */
export async function findReplayMismatches(prisma, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const rows = await prisma.policyDecision.findMany({
    take: sampleSize,
    orderBy: { evaluatedAt: 'desc' },
    select: { id: true, tenantId: true, decisionInput: true, rulesetVersion: true, outcome: true },
  });

  const violations = [];
  for (const row of rows) {
    const rulesetRow = await prisma.policyRuleset.findUnique({
      where: { tenantId_version: { tenantId: row.tenantId, version: row.rulesetVersion } },
      include: { rules: true },
    });
    const ruleset =
      rulesetRow === null
        ? null
        : {
            version: rulesetRow.version,
            rules: rulesetRow.rules.map((r) => ({
              ruleKey: r.ruleKey,
              predicates: r.predicates,
              outcome: r.outcome,
              reasonCode: r.reasonCode,
            })),
          };
    const violation = replayOne(row, ruleset);
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
