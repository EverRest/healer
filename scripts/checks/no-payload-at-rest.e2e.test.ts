import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { acceptResultBatch, PrismaBoundaryRejectionRepository } from '@healer/domain-context';
import { newCorrelationId, TenantContext, withCorrelation } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { findLiveViolations } from './no-payload-at-rest.mjs';

/**
 * `check:no-payload-at-rest` against a real Postgres (003 T031, R-13): a rejection produced by the
 * real ingress door passes, a hand-inserted row with prose in `schema_error_paths` fails — and the
 * failure message names the row, never the prose.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const TENANT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000c1');
const RUNNER = '0190b7a0-0000-7000-8000-0000000000aa';
const MARKER = 'SEEDED-MARKER-jane@example.com';

describe('check:no-payload-at-rest against a real Postgres (003 T031)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('passes for rejections written through acceptResultBatch with a marker-bearing payload', async () => {
    const repo = new PrismaBoundaryRejectionRepository(prisma as never);
    const rawBody = JSON.stringify({ items: [{ [MARKER]: MARKER }], note: MARKER });
    await withCorrelation(newCorrelationId(), () =>
      acceptResultBatch({ rejections: repo }, TENANT, { runnerId: RUNNER, rawBody }),
    ).catch(() => undefined);
    await withCorrelation(newCorrelationId(), () =>
      acceptResultBatch({ rejections: repo }, TENANT, { runnerId: RUNNER, rawBody: `{${MARKER}` }),
    ).catch(() => undefined);

    expect(await prisma.$queryRaw`SELECT 1 FROM "context"."boundary_rejection"`).toHaveLength(2);
    expect(await findLiveViolations(prisma)).toEqual([]);
  });

  it('fails for a hand-inserted row with prose in schema_error_paths or a bad digest, naming neither', async () => {
    await prisma.$executeRaw`
      INSERT INTO "context"."boundary_rejection"
        (id, tenant_id, runner_id, contract_version, schema_error_paths, payload_digest, byte_size, received_at)
      VALUES ('0190b7a0-0000-7000-8000-0000000000e1', ${TENANT.tenantId}::uuid, ${RUNNER}::uuid, 1,
              ARRAY['user ' || ${MARKER} || ' failed to log in'], 'not-a-digest', 3, now())`;
    const violations = await findLiveViolations(prisma);
    expect(violations).toEqual([
      'boundary_rejection 0190b7a0-0000-7000-8000-0000000000e1: payload_digest is not 64 lowercase hex characters',
      'boundary_rejection 0190b7a0-0000-7000-8000-0000000000e1: schema_error_paths[0] is not a structural path',
    ]);
    expect(violations.join()).not.toContain(MARKER);
  });

  it('fails when a column that could hold a payload is added', async () => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "context"."boundary_rejection" ADD COLUMN raw_body text`,
    );
    expect(await findLiveViolations(prisma)).toContain(
      'boundary_rejection has a column outside the allowed list: raw_body',
    );
  });
});
