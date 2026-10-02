import 'reflect-metadata';
import { Module, type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLogger, loadConfig } from '@healer/shared';
import {
  BullmqSignalQueue,
  PrismaAuditRepository,
  PrismaIngestionDeliveryRepository,
  PrismaIssueRepository,
  PrismaTimelineRepository,
  type AuditRepository,
  type IngestionDeliveryRepository,
  type IssueRepository,
  type SignalQueue,
  type TimelineRepository,
} from '@healer/domain-issues';
import { PrismaGraphReadRepository, type GraphReadRepository } from '@healer/domain-architecture';
import {
  PrismaEvidenceGraphRepository,
  PrismaEvidenceRepository,
  type EvidenceGraphRepository,
  type EvidenceRepository,
} from '@healer/domain-evidence';
import {
  PrismaApprovalLifecycleRepository,
  PrismaAutonomyGrantRepository,
  PrismaBudgetLimitRepository,
  PrismaBudgetRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
  type ApprovalLifecycleRepository,
  type AutonomyGrantRepository,
  type BudgetLimitRepository,
  type BudgetRepository,
  type PolicyActionRepository,
  type PolicyDecisionRepository,
  type PolicyRulesetRepository,
} from '@healer/domain-policy';
import { createPrismaClient } from './infrastructure/prisma.js';
import { HEALTH_META, HealthController, type HealthMeta } from './health/health.controller.js';
import {
  INGESTION_DELIVERY_REPOSITORY,
  IngestController,
  SIGNAL_QUEUE,
} from './ingest/ingest.controller.js';
import {
  AUDIT_REPOSITORY,
  EVIDENCE_GRAPH_REPOSITORY,
  EVIDENCE_REPOSITORY,
  ISSUE_REPOSITORY,
  IssuesController,
  TIMELINE_REPOSITORY,
} from './issues/issues.controller.js';
import {
  POLICY_RULESET_REPOSITORY,
  PolicyRulesetsController,
} from './policy/policy-rulesets.controller.js';
import {
  POLICY_DECISION_REPOSITORY,
  PolicyDecisionsController,
} from './policy/policy-decisions.controller.js';
import {
  POLICY_ACTION_REPOSITORY,
  PolicyEvaluationController,
} from './policy/policy-evaluation.controller.js';
import { GRAPH_READ_REPOSITORY, GraphNodesController } from './graph/graph-nodes.controller.js';
import type { RunnerRegistrationRepository } from './runners/domain/repository.js';
import { PrismaRunnerRegistrationRepository } from './runners/infrastructure/prisma-runner-registration-repository.js';
import { RUNNER_REGISTRATION_REPOSITORY, RunnersController } from './runners/runners.controller.js';
import {
  AUTONOMY_GRANT_REPOSITORY,
  AutonomyGrantsController,
} from './policy/autonomy-grants.controller.js';
import {
  BUDGET_LIMIT_REPOSITORY,
  BUDGET_REPOSITORY,
  BudgetsController,
} from './policy/budgets.controller.js';
import {
  APPROVAL_LIFECYCLE_REPOSITORY,
  ApprovalsController,
} from './policy/approvals.controller.js';

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
 * Every 001 route lives under `/api/v1` — the contract's own words
 * (`contracts/openapi.yaml`: "All paths under /api/v1"). Health and readiness stay unprefixed:
 * an orchestrator's liveness/readiness probe is infrastructure configuration, not an API
 * consumer, and a future `/api/v2` must never mean reconfiguring every load balancer's probe
 * path (decisions.md C-52).
 */
export function configureApiPrefix(app: INestApplication): void {
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
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
  issues: IssueRepository,
  evidence: EvidenceRepository,
  audit: AuditRepository,
  timeline: TimelineRepository,
  evidenceGraph: EvidenceGraphRepository,
  policyRulesets: PolicyRulesetRepository,
  policyDecisions: PolicyDecisionRepository,
  policyActions: PolicyActionRepository,
  runnerRegistrations: RunnerRegistrationRepository,
  autonomyGrants: AutonomyGrantRepository,
  budgets: BudgetRepository,
  budgetLimits: BudgetLimitRepository,
  approvals: ApprovalLifecycleRepository,
  graphReads: GraphReadRepository,
): Type<unknown> {
  @Module({
    controllers: [
      HealthController,
      IngestController,
      IssuesController,
      PolicyRulesetsController,
      PolicyDecisionsController,
      PolicyEvaluationController,
      RunnersController,
      AutonomyGrantsController,
      BudgetsController,
      ApprovalsController,
      GraphNodesController,
    ],
    providers: [
      { provide: HEALTH_META, useValue: meta },
      { provide: SIGNAL_QUEUE, useValue: signalQueue },
      { provide: INGESTION_DELIVERY_REPOSITORY, useValue: deliveries },
      { provide: ISSUE_REPOSITORY, useValue: issues },
      { provide: EVIDENCE_REPOSITORY, useValue: evidence },
      { provide: AUDIT_REPOSITORY, useValue: audit },
      { provide: TIMELINE_REPOSITORY, useValue: timeline },
      { provide: EVIDENCE_GRAPH_REPOSITORY, useValue: evidenceGraph },
      { provide: POLICY_RULESET_REPOSITORY, useValue: policyRulesets },
      { provide: POLICY_DECISION_REPOSITORY, useValue: policyDecisions },
      { provide: POLICY_ACTION_REPOSITORY, useValue: policyActions },
      { provide: RUNNER_REGISTRATION_REPOSITORY, useValue: runnerRegistrations },
      { provide: AUTONOMY_GRANT_REPOSITORY, useValue: autonomyGrants },
      { provide: BUDGET_REPOSITORY, useValue: budgets },
      { provide: BUDGET_LIMIT_REPOSITORY, useValue: budgetLimits },
      { provide: APPROVAL_LIFECYCLE_REPOSITORY, useValue: approvals },
      { provide: GRAPH_READ_REPOSITORY, useValue: graphReads },
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
    new PrismaIssueRepository(prisma),
    new PrismaEvidenceRepository(prisma),
    new PrismaAuditRepository(prisma),
    new PrismaTimelineRepository(prisma),
    new PrismaEvidenceGraphRepository(prisma),
    new PrismaPolicyRulesetRepository(prisma),
    new PrismaPolicyDecisionRepository(prisma),
    new PrismaPolicyActionRepository(prisma),
    new PrismaRunnerRegistrationRepository(prisma),
    new PrismaAutonomyGrantRepository(prisma),
    new PrismaBudgetRepository(prisma, { log: logger }),
    new PrismaBudgetLimitRepository(prisma),
    new PrismaApprovalLifecycleRepository(prisma),
    new PrismaGraphReadRepository(prisma),
  );
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
  configureApiPrefix(app);
  configureIngestBodyLimit(app);
  await app.listen(config.HTTP_PORT);
  logger.info({ port: config.HTTP_PORT, version: VERSION }, 'api listening');
}

if (process.argv[1]?.endsWith('main.js')) {
  await bootstrap();
}
