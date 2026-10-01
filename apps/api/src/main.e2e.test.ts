import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type {
  AuditRepository,
  IngestionDeliveryRepository,
  IssueRepository,
  SignalQueue,
} from '@healer/domain-issues';
import type { EvidenceRepository } from '@healer/domain-evidence';
import type {
  AutonomyGrantRepository,
  PolicyActionRepository,
  PolicyDecisionRepository,
  PolicyRulesetRepository,
} from '@healer/domain-policy';
import type { RunnerRegistrationRepository } from './runners/domain/repository.js';
import { configureApiPrefix, createApiModule } from './main.js';

const noopSignalQueue: SignalQueue = { enqueueBatch: () => Promise.resolve() };
const noopDeliveries: IngestionDeliveryRepository = {
  findByDeliveryId: () => Promise.resolve(null),
  recordDelivery: () => Promise.reject(new Error('not implemented in this test')),
};
const noopIssues: IssueRepository = {
  create: () => Promise.reject(new Error('not implemented in this test')),
  findById: () => Promise.resolve(null),
  findOpenByFingerprint: () => Promise.resolve(null),
  findMostRecentlyResolvedByFingerprint: () => Promise.resolve(null),
  transition: () => Promise.reject(new Error('not implemented in this test')),
  recordOccurrence: () => Promise.reject(new Error('not implemented in this test')),
  findOpenCorrelationCandidates: () => Promise.reject(new Error('not implemented in this test')),
  correlate: () => Promise.reject(new Error('not implemented in this test')),
  list: () => Promise.resolve([]),
  findRelationships: () => Promise.reject(new Error('not implemented in this test')),
  findStaleCandidates: () => Promise.reject(new Error('not implemented in this test')),
  markStale: () => Promise.reject(new Error('not implemented in this test')),
};
const noopEvidence: EvidenceRepository = {
  record: () => Promise.reject(new Error('not implemented in this test')),
  findById: () => Promise.resolve(null),
  detach: () => Promise.reject(new Error('not implemented in this test')),
  listByIssue: () => Promise.resolve([]),
};
const noopAudit: AuditRepository = {
  record: () => Promise.reject(new Error('not implemented in this test')),
  listByTarget: () => Promise.resolve([]),
  resolveAgentRunFacts: () => Promise.resolve(null),
};
const noopPolicyRulesets: PolicyRulesetRepository = {
  findByDigest: () => Promise.resolve(null),
  findLatest: () => Promise.resolve(null),
  findByVersion: () => Promise.resolve(null),
  list: () => Promise.resolve([]),
  publish: () => Promise.reject(new Error('not implemented in this test')),
};
const noopPolicyDecisions: PolicyDecisionRepository = {
  record: () => Promise.reject(new Error('not implemented in this test')),
  consume: () => Promise.reject(new Error('not implemented in this test')),
  findById: () => Promise.resolve(null),
  list: () => Promise.resolve([]),
};
const noopPolicyActions: PolicyActionRepository = {
  findByKey: () => Promise.resolve(null),
  list: () => Promise.resolve([]),
};
const noopRunnerRegistrations: RunnerRegistrationRepository = {
  upsert: () => Promise.reject(new Error('not implemented in this test')),
  findByName: () => Promise.resolve(null),
};
const noopAutonomyGrants: AutonomyGrantRepository = {
  findActive: () => Promise.resolve([]),
  findById: () => Promise.resolve(null),
  list: () => Promise.resolve([]),
  create: () => Promise.reject(new Error('not implemented in this test')),
  revoke: () => Promise.reject(new Error('not implemented in this test')),
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
      noopIssues,
      noopEvidence,
      noopAudit,
      { forIssue: () => Promise.resolve([]) },
      { forIssue: () => Promise.resolve({ nodes: [], edges: [] }) },
      noopPolicyRulesets,
      noopPolicyDecisions,
      noopPolicyActions,
      noopRunnerRegistrations,
      noopAutonomyGrants,
    );
    app = await NestFactory.create(ApiModule, { logger: false });
    configureApiPrefix(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves GET /health, unprefixed — a liveness probe is infrastructure config, not an API consumer', async () => {
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

  it('does not also serve /health under the /api/v1 prefix', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
  });
});
