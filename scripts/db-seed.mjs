#!/usr/bin/env node
// `make bootstrap`'s seed step (quickstart: "install, start infrastructure, migrate, seed"):
// one local-dev tenant so a fresh checkout has something to point the API at immediately, plus
// the global `policy_action` registry (002 T014) — `policy_action` has no tenant_id, so it seeds
// once for the whole database, not per tenant.
// Idempotent — safe to run on every bootstrap.
import { PrismaClient } from '../prisma/generated/client/index.js';
import { isMainModule } from './lib/harness.mjs';

export const LOCAL_DEV_TENANT_ID = '00000000-0000-0000-0000-000000000001';

// Mirrors `SEED_POLICY_ACTIONS` in
// `packages/domain/policy/src/domain/policy-action-repository.ts` (the single authority a test or
// a future command imports). Duplicated by hand here, not imported: `make bootstrap` runs this
// script with plain `node` straight after `pnpm install`, before any `pnpm run build` — importing
// a workspace package here would require a built `dist/` that does not exist yet at that point in
// the sequence (confirmed: `Makefile`'s `bootstrap` target has no build step before `db-seed`).
// Two rows, so the ponytail-lazy fix is keeping them in sync by hand rather than reordering
// `bootstrap` or teaching this loader to resolve TypeScript sources.
const SEED_POLICY_ACTIONS = [
  {
    actionKey: 'change.open_pull_request',
    actionClass: 'code_change',
    mutating: true,
    owningSpec: '008',
  },
  {
    actionKey: 'deployment.rollback',
    actionClass: 'reversible_remediation',
    mutating: true,
    owningSpec: '010',
  },
];

// Fixed, not `new Date()`: `update: {}` below never changes `introducedAt` on an existing row
// anyway, but a stable literal keeps a fresh seed and a re-run reporting the same value.
const POLICY_ACTIONS_INTRODUCED_AT = new Date('2026-01-01T00:00:00Z');

if (isMainModule(import.meta.url)) {
  const prisma = new PrismaClient();
  try {
    await prisma.tenant.upsert({
      where: { id: LOCAL_DEV_TENANT_ID },
      update: {},
      create: { id: LOCAL_DEV_TENANT_ID, name: 'local-dev', status: 'active' },
    });
    process.stdout.write(`db-seed: tenant ${LOCAL_DEV_TENANT_ID} (local-dev) ready\n`);

    for (const action of SEED_POLICY_ACTIONS) {
      await prisma.policyAction.upsert({
        where: { actionKey: action.actionKey },
        update: {},
        create: { ...action, introducedAt: POLICY_ACTIONS_INTRODUCED_AT },
      });
    }
    process.stdout.write(`db-seed: policy_action registry (${SEED_POLICY_ACTIONS.length} rows) ready\n`);
  } finally {
    await prisma.$disconnect();
  }
}
