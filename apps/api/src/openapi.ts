import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type {
  IngestionDeliveryRepository,
  IssueRepository,
  SignalQueue,
} from '@healer/domain-issues';
import type { EvidenceRepository } from '@healer/domain-evidence';
import { configureApiPrefix, createApiModule } from './main.js';

// Route shape only — none of these are ever called, contract generation never sends a request.
const noopSignalQueue: SignalQueue = { enqueueBatch: () => Promise.resolve() };
const noopDeliveries: IngestionDeliveryRepository = {
  findByDeliveryId: () => Promise.resolve(null),
  recordDelivery: () => Promise.reject(new Error('not implemented for contract generation')),
};
const noopIssues: IssueRepository = {
  create: () => Promise.reject(new Error('not implemented for contract generation')),
  findById: () => Promise.resolve(null),
  findOpenByFingerprint: () => Promise.resolve(null),
  findMostRecentlyResolvedByFingerprint: () => Promise.resolve(null),
  transition: () => Promise.reject(new Error('not implemented for contract generation')),
  recordOccurrence: () => Promise.reject(new Error('not implemented for contract generation')),
  findOpenCorrelationCandidates: () =>
    Promise.reject(new Error('not implemented for contract generation')),
  correlate: () => Promise.reject(new Error('not implemented for contract generation')),
  list: () => Promise.resolve([]),
  findRelationships: () => Promise.resolve([]),
};
const noopEvidence: EvidenceRepository = {
  record: () => Promise.reject(new Error('not implemented for contract generation')),
  findById: () => Promise.resolve(null),
  detach: () => Promise.reject(new Error('not implemented for contract generation')),
  listByIssue: () => Promise.resolve([]),
};

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
    noopDeliveries,
    noopIssues,
    noopEvidence,
  );
  const app = await NestFactory.create(ApiModule, { logger: false });
  configureApiPrefix(app);
  const config = new DocumentBuilder().setTitle('Healer API').setVersion('0.0.0').build();
  const document = SwaggerModule.createDocument(app, config);
  await app.close();
  return document;
}
