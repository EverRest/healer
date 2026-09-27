import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { SignalQueue } from '@healer/domain-issues';
import { createApiModule } from './main.js';

// Route shape only — this queue is never enqueued to, contract generation never sends a request.
const noopSignalQueue: SignalQueue = { enqueueBatch: () => Promise.resolve() };

/**
 * Contract generation (012 T033, FR-009, FR-012) reuses `createApiModule` rather than a second
 * module declaration — two module definitions is two places the route set can drift apart. It
 * needs no `DATABASE_URL` or any other environment variable: `createApiModule` takes a plain
 * `HealthMeta`, not `loadConfig()`, so `contracts-check` runs the same in CI as on a laptop with
 * no `.env` present (R-09).
 */
export async function buildOpenApiDocument(): Promise<OpenAPIObject> {
  const ApiModule = createApiModule(
    {
      service: 'healer-api',
      version: 'contract',
      build: 'contract',
      runnerProtocolVersion: 0,
    },
    noopSignalQueue,
  );
  const app = await NestFactory.create(ApiModule, { logger: false });
  const config = new DocumentBuilder().setTitle('Healer API').setVersion('0.0.0').build();
  const document = SwaggerModule.createDocument(app, config);
  await app.close();
  return document;
}
