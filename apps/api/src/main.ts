import 'reflect-metadata';
import { Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLogger, loadConfig } from '@healer/shared';
import { HEALTH_META, HealthController, type HealthMeta } from './health/health.controller.js';

const VERSION = '0.5.0';
const BUILD = 'local';

/**
 * Built from a plain `HealthMeta`, not from `loadConfig()` directly — so a test or a script
 * (contract generation, an e2e test booting the real HTTP server) can build the module without
 * needing `DATABASE_URL` or any other environment variable validated only by `bootstrap()`.
 */
export function createApiModule(meta: HealthMeta): Type<unknown> {
  @Module({
    controllers: [HealthController],
    providers: [{ provide: HEALTH_META, useValue: meta }],
  })
  class ApiModule {}
  return ApiModule;
}

export async function bootstrap(): Promise<void> {
  // Configuration is validated once, here, and fails the process rather than surfacing as
  // `undefined` three layers in (FR-043).
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, serviceName: config.SERVICE_NAME });
  const ApiModule = createApiModule({
    service: config.SERVICE_NAME,
    version: VERSION,
    build: BUILD,
    runnerProtocolVersion: config.RUNNER_PROTOCOL_VERSION,
  });
  const app = await NestFactory.create(ApiModule, { logger: false });
  await app.listen(config.HTTP_PORT);
  logger.info({ port: config.HTTP_PORT, version: VERSION }, 'api listening');
}

if (process.argv[1]?.endsWith('main.js')) {
  await bootstrap();
}
