import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLogger, loadConfig } from '@healer/shared';
import { HealthController } from './health/health.controller.js';

const VERSION = '0.5.0';
const BUILD = 'local';

// Configuration is validated once, here, and fails the process rather than surfacing as
// `undefined` three layers in (FR-043). Declared before the module so the provider factory
// cannot read it half-initialised.
const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, serviceName: config.SERVICE_NAME });

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: HealthController,
      useFactory: () =>
        new HealthController({
          service: config.SERVICE_NAME,
          version: VERSION,
          build: BUILD,
          runnerProtocolVersion: config.RUNNER_PROTOCOL_VERSION,
        }),
    },
  ],
})
class ApiModule {}

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule, { logger: false });
  await app.listen(config.HTTP_PORT);
  logger.info({ port: config.HTTP_PORT, version: VERSION }, 'api listening');
}

if (process.argv[1]?.endsWith('main.js')) {
  await bootstrap();
}
