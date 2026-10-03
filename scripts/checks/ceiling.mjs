#!/usr/bin/env node
// `check:ceiling` (002 T038, SC-004, C-18): continuous reconciliation against the live database —
// no `autonomy_grant` exists above `ACTION_CEILING` for its class, and none of class
// `reversible_remediation` exists at all (no attested-undo data source exists yet — unattested
// is the only state this repository can represent today, so any such grant is itself the
// violation). Same posture as `check:policy-coverage`/`check:decision-replay`: production
// monitoring, not a release gate — `make ci` does not run this (quickstart.md's own "Invariant
// checks" list); `gate-ceiling` is the separate, DB-free CI gate that keeps the two mechanisms'
// literals in sync (T038's other half).
//
// `ACTION_CEILING` is called with `hasTestedUndo: false` unconditionally, the same honest
// reading `grantAutonomy` and `GET /policy/actions` already give — this package has no
// attestation source (010's catalogue) to call it with `true`.
import { ACTION_CEILING } from '@healer/domain-policy';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @returns {Promise<string[]>} one message per `autonomy_grant` above its ceiling
 */
export async function findOverCeilingGrants(prisma) {
  const rows = await prisma.$queryRaw`
    SELECT ag.id, ag.tenant_id, ag.action_key, ag.level, pa.action_class
    FROM "policy"."autonomy_grant" ag
    JOIN "policy"."policy_action" pa ON pa.action_key = ag.action_key
    WHERE ag.revoked_at IS NULL
  `;
  return rows
    .map((row) => {
      const ceiling = ACTION_CEILING(row.action_class, false);
      const overCeiling = ceiling.kind === 'none' || row.level > ceiling.level;
      if (!overCeiling) return null;
      const ceilingText = ceiling.kind === 'level' ? ceiling.level : 'none';
      return (
        `autonomy_grant ${row.id} (tenant ${row.tenant_id}, action ${row.action_key}, ` +
        `class ${row.action_class}): level ${row.level} exceeds ceiling ${ceilingText}`
      );
    })
    .filter((message) => message !== null);
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by autonomy-grant-ceiling.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:ceiling', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findOverCeilingGrants(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:ceiling: no autonomy_grant exceeds ACTION_CEILING for its class\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
