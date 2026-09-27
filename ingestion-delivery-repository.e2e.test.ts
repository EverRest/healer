import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  DuplicateDeliveryError,
  PrismaIngestionDeliveryRepository,
  type NewIngestionDelivery,
} from '@healer/domain-issues';
import { TenantContext, newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * The idempotency key for signal ingestion (001 T021, FR-004, R-09) — proves the unique
 * constraint `(tenant_id, provider, delivery_id)` is what actually stops a duplicate, not
 * application-level discipline: a second `recordDelivery` for the same key throws
 * `DuplicateDeliveryError`, translated from Postgres's own P2002, not caught by a prior read.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000a1';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000a2';

const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);

function newDelivery(overrides: Partial<NewIngestionDelivery> = {}): NewIngestionDelivery {
  return {
    id: randomUUID(),
    provider: 'sentry',
    deliveryId: 'delivery-1',
    signalCount: 3,
    outcome: 'accepted',
    ...overrides,
  };
}

describe('PrismaIngestionDeliveryRepository (001 T021, FR-004, R-09)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaIngestionDeliveryRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    repo = new PrismaIngestionDeliveryRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('records a delivery and reads it back for the owning tenant', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newDelivery();
      const recorded = await repo.recordDelivery(scope(CONTEXT, input));
      expect(recorded).toMatchObject({
        tenantId: TENANT_ID,
        provider: 'sentry',
        deliveryId: 'delivery-1',
        signalCount: 3,
        outcome: 'accepted',
      });

      const found = await repo.findByDeliveryId(
        scope(CONTEXT, { provider: 'sentry', deliveryId: 'delivery-1' }),
      );
      expect(found).toMatchObject({ signalCount: 3, outcome: 'accepted' });
    }));

  it('returns null for a delivery id that was never recorded', () =>
    withCorrelation(newCorrelationId(), async () => {
      const found = await repo.findByDeliveryId(
        scope(CONTEXT, { provider: 'sentry', deliveryId: randomUUID() }),
      );
      expect(found).toBeNull();
    }));

  it('never returns another tenant’s delivery — the query itself is tenant-scoped', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newDelivery({ deliveryId: 'delivery-cross-tenant' });
      await repo.recordDelivery(scope(CONTEXT, input));

      const foundByOtherTenant = await repo.findByDeliveryId(
        scope(OTHER_CONTEXT, { provider: 'sentry', deliveryId: 'delivery-cross-tenant' }),
      );
      expect(foundByOtherTenant).toBeNull();
    }));

  it('the same tenant, provider and delivery id recorded twice throws DuplicateDeliveryError — the unique constraint, not a prior read', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newDelivery({ deliveryId: 'delivery-dup' });
      await repo.recordDelivery(scope(CONTEXT, input));

      await expect(
        repo.recordDelivery(scope(CONTEXT, newDelivery({ deliveryId: 'delivery-dup' }))),
      ).rejects.toBeInstanceOf(DuplicateDeliveryError);
    }));

  it('the same delivery id is not a duplicate across two different tenants', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newDelivery({ deliveryId: 'delivery-shared-id' });
      await repo.recordDelivery(scope(CONTEXT, input));

      const recordedForOtherTenant = await repo.recordDelivery(
        scope(OTHER_CONTEXT, newDelivery({ deliveryId: 'delivery-shared-id' })),
      );
      expect(recordedForOtherTenant).toMatchObject({
        tenantId: OTHER_TENANT_ID,
        deliveryId: 'delivery-shared-id',
      });
    }));

  it('the same delivery id is not a duplicate across two different providers for the same tenant', () =>
    withCorrelation(newCorrelationId(), async () => {
      const input = newDelivery({
        provider: 'sentry',
        deliveryId: 'delivery-shared-across-providers',
      });
      await repo.recordDelivery(scope(CONTEXT, input));

      const recordedForOtherProvider = await repo.recordDelivery(
        scope(
          CONTEXT,
          newDelivery({ provider: 'datadog', deliveryId: 'delivery-shared-across-providers' }),
        ),
      );
      expect(recordedForOtherProvider).toMatchObject({
        provider: 'datadog',
        deliveryId: 'delivery-shared-across-providers',
      });
    }));
});
