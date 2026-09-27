#!/usr/bin/env node
// `make bootstrap`'s seed step (quickstart: "install, start infrastructure, migrate, seed"):
// one local-dev tenant so a fresh checkout has something to point the API at immediately.
// Idempotent — safe to run on every bootstrap.
import { PrismaClient } from '../prisma/generated/client/index.js';
import { isMainModule } from './lib/harness.mjs';

export const LOCAL_DEV_TENANT_ID = '00000000-0000-0000-0000-000000000001';

if (isMainModule(import.meta.url)) {
  const prisma = new PrismaClient();
  try {
    await prisma.tenant.upsert({
      where: { id: LOCAL_DEV_TENANT_ID },
      update: {},
      create: { id: LOCAL_DEV_TENANT_ID, name: 'local-dev', status: 'active' },
    });
    process.stdout.write(`db-seed: tenant ${LOCAL_DEV_TENANT_ID} (local-dev) ready\n`);
  } finally {
    await prisma.$disconnect();
  }
}
