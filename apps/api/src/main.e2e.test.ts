import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { IngestionDeliveryRepository, SignalQueue } from '@healer/domain-issues';
import { createApiModule } from './main.js';

const noopSignalQueue: SignalQueue = { enqueueBatch: () => Promise.resolve() };
const noopDeliveries: IngestionDeliveryRepository = {
  findByDeliveryId: () => Promise.resolve(null),
  recordDelivery: () => Promise.reject(new Error('not implemented in this test')),
};

/**
 * Boots the real Nest DI graph and hits it over HTTP — not just `buildHealthReport`, the plain
 * function `health.test.ts` covers. Nothing exercised `NestFactory.create` against the actual
 * `ApiModule` shape before this: the controller's constructor took a bare object-typed
 * parameter, which Nest cannot inject (it reflects to `Object`, matching no provider), and the
 * app has never once been able to start. `unit`-level tests could not have caught this — Nest's
 * dependency graph is only wrong at wiring time, which only a real boot exercises.
 */
describe('api boots and serves health/ready over HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ApiModule = createApiModule(
      {
        service: 'healer-api',
        version: '0.5.0',
        build: 'test',
        runnerProtocolVersion: 1,
      },
      noopSignalQueue,
      noopDeliveries,
    );
    app = await NestFactory.create(ApiModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves GET /health', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'healer-api',
      version: '0.5.0',
      build: 'test',
    });
  });

  it('serves GET /ready with the runner protocol version and dependency list', async () => {
    const response = await request(app.getHttpServer()).get('/ready').expect(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      runnerProtocolVersion: 1,
      dependencies: [],
    });
  });
});
