import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BullmqSignalQueue,
  PrismaAuditRepository,
  PrismaIngestionDeliveryRepository,
  PrismaIssueRepository,
  PrismaTimelineRepository,
} from '@healer/domain-issues';
import { PrismaEvidenceGraphRepository, PrismaEvidenceRepository } from '@healer/domain-evidence';
import {
  evaluateAndBind,
  publishRuleset,
  PrismaAutonomyEpochRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
  type DecisionInput,
  type RuleBody,
} from '@healer/domain-policy';
import { TenantContext, newCorrelationId, withCorrelation } from '@healer/shared';
import { PrismaClient } from '@healer/prisma-client';
import {
  assertTenantIsolated,
  assertTenantIsolatedList,
  assertTenantScopedEnqueue,
} from '../../test/tenant-isolation.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { configureApiPrefix, createApiModule } from './src/main.js';

/**
 * The six `/policy/*` endpoints (002 T027–T029, T032) over real HTTP against a real Postgres:
 * publish/list/resolve a rule set, list/get/replay a decision, dry-run evaluation, and the action
 * registry — plus the tenant-isolation matrix `.claude/rules/backend-nestjs.md` requires per
 * endpoint that takes an id/version. `GET /policy/actions` and `POST /policy/dry-run` are the two
 * routes `gate-isolation`'s `EXEMPT_PATHS` names and this file's own last `describe` block
 * explains why (global registry; writes nothing to read back).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000e1';

/** The wire shape (`contracts/openapi.yaml`'s `Predicate`: `{field, operator, value}`) has no
 *  `kind` — the DTO derives it from `field`. `allowRule()` builds the domain `RuleBody` (used
 *  directly with `publishRuleset`, which needs `kind`); this strips it back off for a request
 *  body actually sent over HTTP. */
function wireRule(rule: RuleBody): unknown {
  return { ...rule, predicates: rule.predicates.map(({ kind: _kind, ...p }) => p) };
}

function allowRule(overrides: Partial<RuleBody> = {}): RuleBody {
  return {
    ruleKey: `allow-${randomUUID()}`,
    predicates: [
      { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
    ],
    outcome: 'allow',
    reasonCode: 'NO_ADOPTED_EXPECTATION',
    note: '',
    ...overrides,
  };
}

function buildDecisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    action: { actionKey: 'change.open_pull_request', actionClass: 'code_change' },
    target: {
      componentId: 'component-1',
      environment: 'production',
      issueKind: 'production_incident',
      targetRef: 'target-1',
      fingerprint: 'fingerprint-1',
    },
    issue: { state: 'diagnosed', classification: 'null_pointer' },
    eligibility: { codeProblemVerdict: 'code_problem', fixEligible: true },
    evidence: { complete: true, conclusionHasLink: true },
    reproduction: { outcome: 'pass' },
    impact: {
      classification: 'localized',
      touchesPublicContract: false,
      touchesMigration: false,
      touchesAuthPath: false,
      touchesMoneyPath: false,
      closure: { memberIds: ['component-1'], maxDepth: 1 },
    },
    reversibility: { reversible: true, hasTestedUndo: true },
    autonomy: { level: 2 },
    budget: { consumed: 0, limit: 100, declaredMaxCost: 1, degradationStep: 0 },
    cooldown: { recentAllowCount: 0, windowSeconds: 3600, attemptCount: 0 },
    escalation: { attemptCount: 0 },
    evaluatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Over the wire, `evaluatedAt` is a JSON string — the shape `parseDryRunRequest` expects. */
function dryRunBody(overrides: Partial<DecisionInput> = {}): unknown {
  return { ...buildDecisionInput(overrides), evaluatedAt: '2026-01-01T00:00:00.000Z' };
}

describe('/policy (002 T027-T030, T032)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let rulesets: PrismaPolicyRulesetRepository;
  let decisions: PrismaPolicyDecisionRepository;
  let autonomyEpochs: PrismaAutonomyEpochRepository;

  const path = (p: string) => `/api/v1${p}`;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    // `policy_action` is global, seeded once for the whole database (mirrors `db-seed.mjs`'s own
    // copy of `SEED_POLICY_ACTIONS` — see that file's comment for why it is duplicated, not
    // imported, there; this test imports the real package since it runs under vitest, not plain
    // `node` pre-build).
    await query(
      pg,
      `insert into "policy"."policy_action" (action_key, action_class, mutating, owning_spec, introduced_at)
       values ('change.open_pull_request', 'code_change', true, '008', now()),
              ('deployment.rollback', 'reversible_remediation', true, '010', now())`,
    );

    prisma = new PrismaClient({ datasourceUrl: pg.url });
    rulesets = new PrismaPolicyRulesetRepository(prisma);
    decisions = new PrismaPolicyDecisionRepository(prisma);
    autonomyEpochs = new PrismaAutonomyEpochRepository(prisma);

    const ApiModule = createApiModule(
      { service: 'healer-api', version: 'test', build: 'test', runnerProtocolVersion: 1 },
      new BullmqSignalQueue({ url: 'redis://127.0.0.1:6399' }),
      new PrismaIngestionDeliveryRepository(prisma),
      new PrismaIssueRepository(prisma),
      new PrismaEvidenceRepository(prisma),
      new PrismaAuditRepository(prisma),
      new PrismaTimelineRepository(prisma),
      new PrismaEvidenceGraphRepository(prisma),
      rulesets,
      decisions,
      new PrismaPolicyActionRepository(prisma),
    );
    app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
    configureApiPrefix(app);
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  const publishUnder = (tenantId: string, rules: readonly RuleBody[] = [allowRule()]) =>
    withCorrelation(newCorrelationId(), () =>
      publishRuleset(rulesets, TenantContext.forTrustedInternalUse(tenantId), {
        rules,
        publishedBy: 'pavlo',
      }),
    );

  const decideUnder = (tenantId: string, overrides: Partial<DecisionInput> = {}) =>
    withCorrelation(newCorrelationId(), async () => {
      const tenant = TenantContext.forTrustedInternalUse(tenantId);
      await publishUnder(tenantId);
      const { decision } = await evaluateAndBind({ rulesets, decisions, autonomyEpochs }, tenant, {
        decisionInput: buildDecisionInput(overrides),
      });
      return decision;
    });

  describe('GET /policy/rulesets, POST /policy/rulesets, GET /policy/rulesets/{version} (T027)', () => {
    it('publishes a rule set and lists it back for the same tenant', async () => {
      const response = await request(app.getHttpServer())
        .post(path('/policy/rulesets'))
        .set('X-Tenant-Id', TENANT_ID)
        .set('X-Actor-Id', 'pavlo')
        .set('Idempotency-Key', randomUUID())
        .send({ rules: [wireRule(allowRule())] })
        .expect(201);
      expect(response.body).toMatchObject({ version: expect.any(Number) });

      const list = await request(app.getHttpServer())
        .get(path('/policy/rulesets'))
        .set('X-Tenant-Id', TENANT_ID)
        .expect(200);
      expect(list.body.items.some((r: { id: string }) => r.id === response.body.id)).toBe(true);
    });

    it('422s VALIDATION for an unknown predicate field — RULESET_INVALID at the schema boundary', async () => {
      await request(app.getHttpServer())
        .post(path('/policy/rulesets'))
        .set('X-Tenant-Id', TENANT_ID)
        .set('X-Actor-Id', 'pavlo')
        .set('Idempotency-Key', randomUUID())
        .send({
          rules: [
            {
              ruleKey: 'bad',
              predicates: [{ field: 'action.confidence', operator: 'equals', value: 'x' }],
              outcome: 'allow',
              reasonCode: 'NO_ADOPTED_EXPECTATION',
              note: '',
            },
          ],
        })
        .expect(422);
    });

    it("422s for an operator outside the field's domain", async () => {
      await request(app.getHttpServer())
        .post(path('/policy/rulesets'))
        .set('X-Tenant-Id', TENANT_ID)
        .set('X-Actor-Id', 'pavlo')
        .set('Idempotency-Key', randomUUID())
        .send({
          rules: [
            {
              ruleKey: 'bad-op',
              predicates: [{ field: 'evidence.complete', operator: 'atLeast', value: 1 }],
              outcome: 'allow',
              reasonCode: 'NO_ADOPTED_EXPECTATION',
              note: '',
            },
          ],
        })
        .expect(422);
    });

    it('GET /policy/rulesets/{version} resolves a version even after it is superseded (SC-003)', async () => {
      const tenantId = randomUUID();
      const v1 = await publishUnder(tenantId, [allowRule({ ruleKey: `v1-${randomUUID()}` })]);
      await publishUnder(tenantId, [allowRule({ ruleKey: `v2-${randomUUID()}`, outcome: 'deny' })]);

      const response = await request(app.getHttpServer())
        .get(path(`/policy/rulesets/${v1.version}`))
        .set('X-Tenant-Id', tenantId)
        .expect(200);
      expect(response.body.id).toBe(v1.id);
    });

    it("404s an unknown version, and 404s (never 403) another tenant's version", async () => {
      await request(app.getHttpServer())
        .get(path('/policy/rulesets/999999'))
        .set('X-Tenant-Id', TENANT_ID)
        .expect(404);

      await assertTenantIsolated(app, 'GET', '/api/v1/policy/rulesets/:version', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderTenant: async (tenantId) => String((await publishUnder(tenantId)).version),
      });
    });
  });

  describe('GET /policy/decisions, GET /policy/decisions/{decisionId}, POST .../replay (T028)', () => {
    it('records a decision via EvaluateAndBind (seeded through the domain package) and reads it back', async () => {
      const tenantId = randomUUID();
      const decision = await decideUnder(tenantId);

      const one = await request(app.getHttpServer())
        .get(path(`/policy/decisions/${decision.id}`))
        .set('X-Tenant-Id', tenantId)
        .expect(200);
      expect(one.body).toMatchObject({
        id: decision.id,
        outcome: 'allow',
        actionKey: 'change.open_pull_request',
      });

      const list = await request(app.getHttpServer())
        .get(path('/policy/decisions'))
        .set('X-Tenant-Id', tenantId)
        .expect(200);
      expect(list.body.items.some((d: { id: string }) => d.id === decision.id)).toBe(true);

      const filtered = await request(app.getHttpServer())
        .get(path(`/policy/decisions?outcome=allow&actionKey=change.open_pull_request`))
        .set('X-Tenant-Id', tenantId)
        .expect(200);
      expect(filtered.body.items.some((d: { id: string }) => d.id === decision.id)).toBe(true);
    });

    it("404s an unknown decision id, and 404s (never 403) another tenant's decision", async () => {
      await request(app.getHttpServer())
        .get(path(`/policy/decisions/${randomUUID()}`))
        .set('X-Tenant-Id', TENANT_ID)
        .expect(404);

      await assertTenantIsolated(app, 'GET', '/api/v1/policy/decisions/:decisionId', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderTenant: async (tenantId) => (await decideUnder(tenantId)).id,
      });
    });

    it("replay reports an identical outcome for an untouched history, and 404s another tenant's decision", async () => {
      const tenantId = randomUUID();
      const decision = await decideUnder(tenantId);

      const response = await request(app.getHttpServer())
        .post(path(`/policy/decisions/${decision.id}/replay`))
        .set('X-Tenant-Id', tenantId)
        .expect(200);
      expect(response.body.identical).toBe(true);
      expect(response.body.replayed.outcome).toBe('allow');

      await assertTenantIsolated(app, 'POST', '/api/v1/policy/decisions/:decisionId/replay', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderTenant: async (tenantId) => (await decideUnder(tenantId)).id,
      });
    });
  });

  describe('POST /policy/dry-run and GET /policy/actions (T029)', () => {
    it('evaluates and writes nothing — no new policy_decision row', async () => {
      const tenantId = randomUUID();
      await publishUnder(tenantId);
      const before = await prisma.policyDecision.count({ where: { tenantId } });

      const response = await request(app.getHttpServer())
        .post(path('/policy/dry-run'))
        .set('X-Tenant-Id', tenantId)
        .send(dryRunBody())
        .expect(200);
      expect(response.body.outcome).toBe('allow');

      const after = await prisma.policyDecision.count({ where: { tenantId } });
      expect(after).toBe(before);
    });

    it('422s an unknown key, including a smuggled confidence field (quickstart 3, over HTTP)', async () => {
      const tenantId = randomUUID();
      await publishUnder(tenantId);
      await request(app.getHttpServer())
        .post(path('/policy/dry-run'))
        .set('X-Tenant-Id', tenantId)
        .send({ ...dryRunBody(), confidence: 0.9 })
        .expect(422);
    });

    it("resolves the caller's own tenant's ruleset, never another tenant's (no gate-isolation helper fits a write-nothing endpoint, so this asserts the property directly)", async () => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      await publishUnder(tenantA, [allowRule({ ruleKey: `dryrun-a-${randomUUID()}` })]);
      await publishUnder(tenantB, [
        allowRule({ ruleKey: `dryrun-b-${randomUUID()}`, outcome: 'deny' }),
      ]);

      const asA = await request(app.getHttpServer())
        .post(path('/policy/dry-run'))
        .set('X-Tenant-Id', tenantA)
        .send(dryRunBody())
        .expect(200);
      const asB = await request(app.getHttpServer())
        .post(path('/policy/dry-run'))
        .set('X-Tenant-Id', tenantB)
        .send(dryRunBody())
        .expect(200);

      expect(asA.body.outcome).toBe('allow');
      expect(asB.body.outcome).toBe('deny');
    });

    it('lists the action registry with a computed ceilingLevel', async () => {
      const response = await request(app.getHttpServer())
        .get(path('/policy/actions'))
        .set('X-Tenant-Id', TENANT_ID)
        .expect(200);
      expect(response.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionKey: 'change.open_pull_request', ceilingLevel: 2 }),
          // Unattested undo (010's catalogue does not exist yet) — null, not a level (contract).
          expect.objectContaining({ actionKey: 'deployment.rollback', ceilingLevel: null }),
        ]),
      );
    });
  });

  describe('publish is tenant-scoped, and rule set / decision lists never leak (FR-018)', () => {
    it('POST /policy/rulesets: a rule published under tenant A never appears under tenant B', async () =>
      assertTenantScopedEnqueue(app, 'POST', '/api/v1/policy/rulesets', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        expectStatus: 201,
        bodyFor: (marker) => ({ rules: [wireRule(allowRule({ ruleKey: marker }))] }),
        headersFor: () => ({ 'X-Actor-Id': 'pavlo', 'Idempotency-Key': randomUUID() }),
        tenantIdFor: async (marker) => {
          const rule = await prisma.policyRule.findFirst({ where: { ruleKey: marker } });
          if (rule === null) return undefined;
          const ruleset = await prisma.policyRuleset.findUnique({ where: { id: rule.rulesetId } });
          return ruleset?.tenantId;
        },
      }));

    it("GET /policy/rulesets: a list never contains another tenant's rule sets", async () => {
      const tenantId = randomUUID();
      const published = await publishUnder(tenantId);
      await assertTenantIsolatedList(app, 'GET', '/api/v1/policy/rulesets', {
        tenantA: tenantId,
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderA: async () => published.id,
        responseContainsMarker: (body, marker) =>
          (body as { items: { id: string }[] }).items.some((item) => item.id === marker),
      });
    });

    it("GET /policy/decisions: a list never contains another tenant's decisions", async () => {
      const tenantId = randomUUID();
      const decision = await decideUnder(tenantId);
      await assertTenantIsolatedList(app, 'GET', '/api/v1/policy/decisions', {
        tenantA: tenantId,
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderA: async () => decision.id,
        responseContainsMarker: (body, marker) =>
          (body as { items: { id: string }[] }).items.some((item) => item.id === marker),
      });
    });
  });
});
