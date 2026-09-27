#!/usr/bin/env node
// `check:expired-evidence` (001 T035): nothing past `expires_at` is still `linked` — the data-
// model's own lifecycle (data-model.md: `linked -> detached -> (expires_at) -> purged`) says
// evidence detaches before it can expire; this continuously verifies real data still agrees.
// A violation here does not fix itself — nothing in 001 detaches evidence automatically on
// expiry, and purging is T052's own, not-yet-built job — so this exists to surface the gap to a
// human, the same "evidence or silence" spirit as every other continuous check in this file.
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

/**
 * Isolated so an e2e test can drive the real query against a disposable Postgres rather than
 * trusting this untested against the one thing it exists to check.
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 */
export async function findExpiredLinkedEvidence(prisma) {
  return prisma.$queryRaw`
    SELECT id, tenant_id, expires_at FROM "evidence"."evidence"
    WHERE ref_state = 'linked' AND expires_at < now()
    ORDER BY expires_at ASC
  `;
}

/** @param {{ id: string, tenant_id: string, expires_at: Date }[]} violations */
export function describeViolations(violations) {
  const sample = violations
    .slice(0, 10)
    .map((v) => `${v.id} (tenant ${v.tenant_id}, expired ${v.expires_at.toISOString()})`);
  return (
    `${violations.length} evidence row(s) past expires_at are still linked: ${sample.join(', ')}` +
    (violations.length > sample.length ? ', ...' : '')
  );
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by expired-evidence.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:expired-evidence', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findExpiredLinkedEvidence(prisma);
      if (violations.length > 0) throw new Error(describeViolations(violations));
      process.stderr.write('check:expired-evidence: no linked evidence past expires_at\n');
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
