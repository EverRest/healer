import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { COLLECTION_CONTRACT_VERSION, COLLECTOR_KEYS } from '@healer/boundary-contract';
import {
  acceptResultBatch,
  boundaryPayloadRejectedEvent,
  BoundarySchemaRejectedError,
  declaredCollectors,
  PrismaBoundaryRejectionRepository,
  PrismaCollectorRegistrationRepository,
} from '@healer/domain-context';
import { newCorrelationId, scope, TenantContext, withCorrelation } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 003 T013 + T029 against a real Postgres: a rejected payload leaves exactly one
 * `boundary_rejection` row and one outbox event, in one transaction, and no byte of the payload;
 * the collector registry sync is an idempotent upsert of the in-code declarations.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));
const TENANT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000c1');
const RUNNER = '0190b7a0-0000-7000-8000-0000000000aa';
const MARKER = 'SEEDED-MARKER-jane@example.com';

const BAD_BATCH = JSON.stringify({
  passId: '0190b7a0-0000-7000-8000-000000000001',
  planDigest: 'sha256:abc',
  contractVersion: COLLECTION_CONTRACT_VERSION,
  runnerImageVersion: '0.52.0',
  collectedAt: '2026-01-01T00:00:05Z',
  sourceOutcomes: [],
  items: [{ evidence: { kind: 'error_signature', message: MARKER }, [MARKER]: MARKER }],
});

describe('boundary rejection persistence (003 T029, R-13)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaBoundaryRejectionRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${entry}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    repo = new PrismaBoundaryRejectionRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('records one row and one outbox event for a rejected payload, and stores none of it', async () => {
    const error = await withCorrelation(newCorrelationId(), () =>
      acceptResultBatch({ rejections: repo }, TENANT, { runnerId: RUNNER, rawBody: BAD_BATCH }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoundarySchemaRejectedError);

    const rows = await prisma.boundaryRejection.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT.tenantId,
      runnerId: RUNNER,
      byteSize: Buffer.byteLength(BAD_BATCH),
      contractVersion: COLLECTION_CONTRACT_VERSION,
    });
    const outbox = await prisma.outbox.findMany({ where: { name: 'BoundaryPayloadRejected' } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.subjectId).toBe(rows[0]!.id);

    // Every byte the database now holds about this rejection, searched for the planted marker.
    const dump = JSON.stringify([rows, outbox]);
    expect(dump).not.toContain(MARKER);
  });

  it('a failure after the row insert rolls the row back with the event (one transaction)', async () => {
    const before = await prisma.boundaryRejection.count();
    const id = '0190b7a0-0000-7000-8000-0000000000bb';
    await expect(
      withCorrelation(newCorrelationId(), () =>
        repo.record(
          scope(TENANT, {
            id,
            runnerId: RUNNER,
            contractVersion: 1,
            schemaErrorPaths: ['$#invalid_json'],
            payloadDigest: 'a'.repeat(64),
            byteSize: 1,
            receivedAt: new Date(),
          }),
          {
            ...boundaryPayloadRejectedEvent(TENANT.tenantId, {
              rejectionId: id,
              runnerId: RUNNER,
              contractVersion: 1,
              schemaErrorPaths: ['$#invalid_json'],
            }),
            tenantId: 'not-a-uuid', // the outbox insert fails, after the row insert succeeded
          },
        ),
      ),
    ).rejects.toThrow();
    expect(await prisma.boundaryRejection.count()).toBe(before);
    expect(await prisma.boundaryRejection.count({ where: { id } })).toBe(0);
  });

  it("lists only this tenant's rejections, with totals and per-runner counts", async () => {
    const other = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000c2');
    await withCorrelation(newCorrelationId(), () =>
      acceptResultBatch({ rejections: repo }, other, { runnerId: RUNNER, rawBody: '{' }),
    ).catch(() => undefined);

    const mine = await repo.list(scope(TENANT, {}));
    expect(mine.total).toBe(1);
    expect(mine.items.every((r) => r.tenantId === TENANT.tenantId)).toBe(true);
    expect(mine.countsByRunner).toEqual({ [RUNNER]: 1 });
    expect((await repo.list(scope(TENANT, { since: new Date(Date.now() + 60_000) }))).total).toBe(
      0,
    );
    expect(
      (await repo.list(scope(TENANT, { runnerId: '0190b7a0-0000-7000-8000-0000000000ff' }))).total,
    ).toBe(0);
  });
});

describe('collector registration sync (003 T013, R-12)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${entry}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('upserts one row per declared collector, idempotently, and repairs drift', async () => {
    const sync = new PrismaCollectorRegistrationRepository(prisma);
    await sync.syncCollectorRegistry(declaredCollectors());
    const first = await prisma.collectorRegistration.findMany({ orderBy: { collectorKey: 'asc' } });
    expect(first.map((r) => r.collectorKey)).toEqual([...COLLECTOR_KEYS]);
    expect(first.find((r) => r.collectorKey === 'source_file')).toMatchObject({
      itemClasses: ['file_path'],
      parameterSchema: { fields: ['paths'] },
      requiredCapability: 'collect:source_file',
      plane: 'execution',
    });

    await prisma.collectorRegistration.update({
      where: { collectorKey: 'loki_logs' },
      data: { defaultTimeoutMs: 1 },
    });
    await sync.syncCollectorRegistry(declaredCollectors());
    const second = await prisma.collectorRegistration.findMany({
      orderBy: { collectorKey: 'asc' },
    });
    expect(second).toEqual(first);
  });
});
