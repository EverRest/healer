import 'reflect-metadata';
import { Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLogger, loadConfig } from '@healer/shared';
import {
  BullmqSignalQueue,
  PrismaIngestionDeliveryRepository,
  type IngestionDeliveryRepository,
  type SignalQueue,
} from '@healer/domain-issues';
import { createPrismaClient } from './infrastructure/prisma.js';
import { HEALTH_META, HealthController, type HealthMeta } from './health/health.controller.js';
import {
  INGESTION_DELIVERY_REPOSITORY,
  IngestController,
  SIGNAL_QUEUE,
} from './ingest/ingest.controller.js';

const VERSION = '0.5.0';
const BUILD = 'local';

/**
 * 1000 signals (the batch cap the DTO enforces), each with an unbounded `frames` array,
 * comfortably exceeds Express's 100kb default JSON body limit — without this, a legitimate
 * near-cap delivery gets a transport-level 413 before the DTO's own cap ever has a chance to
 * apply. The cap that matters is the one in `ingest-signals.dto.ts`; this just stops the
 * transport from rejecting valid batches under it.
 */
export function configureIngestBodyLimit(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: '5mb' });
}

/**
 * Built from a plain `HealthMeta` and explicit dependencies, not from `loadConfig()` directly —
 * so a test or a script (contract generation, an e2e test booting the real HTTP server) can
 * build the module without needing `DATABASE_URL`/`REDIS_URL` or any other environment variable
 * validated only by `bootstrap()`. Both `signalQueue` and `deliveries` are always required and
 * `IngestController` is always registered: a module shape that varies by caller is the same
 * contract drift that keeping one `createApiModule` was meant to prevent.
 */
export function createApiModule(
  meta: HealthMeta,
  signalQueue: SignalQueue,
  deliveries: IngestionDeliveryRepository,
): Type<unknown> {
  @Module({
    controllers: [HealthController, IngestController],
    providers: [
      { provide: HEALTH_META, useValue: meta },
      { provide: SIGNAL_QUEUE, useValue: signalQueue },
      { provide: INGESTION_DELIVERY_REPOSITORY, useValue: deliveries },
    ],
  })
  class ApiModule {}
  return ApiModule;
}

export async function bootstrap(): Promise<void> {
  // Configuration is validated once, here, and fails the process rather than surfacing as
  // `undefined` three layers in (FR-043).
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, serviceName: config.SERVICE_NAME });
  const prisma = createPrismaClient(config.DATABASE_URL);
  const ApiModule = createApiModule(
    {
      service: config.SERVICE_NAME,
      version: VERSION,
      build: BUILD,
      runnerProtocolVersion: config.RUNNER_PROTOCOL_VERSION,
    },
    new BullmqSignalQueue({ url: config.REDIS_URL }),
    new PrismaIngestionDeliveryRepository(prisma),
  );
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
  configureIngestBodyLimit(app);
  await app.listen(config.HTTP_PORT);
  logger.info({ port: config.HTTP_PORT, version: VERSION }, 'api listening');
}

if (process.argv[1]?.endsWith('main.js')) {
  await bootstrap();
}
