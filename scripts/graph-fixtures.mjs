#!/usr/bin/env node
// `make graph-fixtures` (004 T004, SC-008): one command, three architecture fixtures — monolith,
// microservices, serverless — driving the one cross-architecture query set proven in
// graph-fixtures.e2e.test.ts. Same `PrismaClient` / `isMainModule` pattern as db-seed.mjs.
// Idempotent: delete-then-insert per fixture tenant, safe to rerun; each fixture owns its own
// tenant so the three can be loaded independently or together without colliding.
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '../prisma/generated/client/index.js';
import { isMainModule } from './lib/harness.mjs';

export const MONOLITH_TENANT_ID = '00000000-0000-0000-a000-000000000001';
export const MICROSERVICES_TENANT_ID = '00000000-0000-0000-a000-000000000002';
export const SERVERLESS_TENANT_ID = '00000000-0000-0000-a000-000000000003';

// Mirrors packages/domain/architecture/src/domain/node-identity.ts's `mintNodeId` — copied rather
// than imported so this plain-`node`-run script never needs that workspace package's `dist/`
// built first (the same reason db-seed.mjs imports the generated Prisma client by relative path
// instead of through `@healer/prisma-client`).
function mintNodeId(now = Date.now()) {
  const bytes = randomBytes(16);
  const ts = BigInt(Math.floor(now));
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The 'human_authored' ordinal from provenance-strength.ts's PROVENANCE_STRENGTH_V1 (=65) — every
// row below is hand-authored, not discovered, so this is the one class and ordinal these fixtures
// ever use. Confidence is 100: a fixture is asserted ground truth, not an inference with doubt
// attached.
const HUMAN_AUTHORED_STRENGTH = 65;
const FIXTURE_CONFIDENCE = 100;
const FIXTURE_ACTOR = 'fixture';

const NODE_LAYER = {
  component: 'code',
  repository: 'code',
  endpoint: 'code',
  deployment_unit: 'runtime',
};
const EDGE_LAYER = {
  contains: 'code',
  built_from: 'code',
  depends_on: 'code',
  implements: 'code',
  deploys: 'runtime',
  calls: 'runtime',
  exposes: 'runtime',
};

async function createNode(prisma, tenantId, spec) {
  const id = mintNodeId();
  await prisma.graphNode.create({
    data: {
      id,
      tenantId,
      nodeKind: spec.nodeKind,
      layer: NODE_LAYER[spec.nodeKind],
      name: spec.name,
      naturalKey: spec.name,
      provenance: 'human_authored',
      strength: HUMAN_AUTHORED_STRENGTH,
      confidence: FIXTURE_CONFIDENCE,
      state: 'confirmed',
      actorRef: FIXTURE_ACTOR,
      validFromVersion: 1,
    },
  });
  if (spec.nodeKind === 'component') {
    await prisma.componentAttr.create({
      data: {
        nodeId: id,
        tenantId,
        componentType: spec.componentType,
        characteristics: spec.characteristics ?? [],
        ownerRef: spec.ownerRef ?? null,
      },
    });
  } else if (spec.nodeKind === 'deployment_unit') {
    await prisma.deploymentUnitAttr.create({
      data: {
        nodeId: id,
        tenantId,
        environment: spec.environment,
        runtimeKind: spec.runtimeKind,
        runtimeRef: spec.runtimeRef,
        currentVersion: spec.currentVersion ?? null,
      },
    });
  } else if (spec.nodeKind === 'repository') {
    await prisma.repositoryAttr.create({
      data: {
        nodeId: id,
        tenantId,
        vcs: spec.vcs,
        projectRef: spec.projectRef,
        defaultBranch: spec.defaultBranch,
      },
    });
  } else if (spec.nodeKind === 'endpoint') {
    await prisma.endpointAttr.create({
      data: {
        nodeId: id,
        tenantId,
        protocol: spec.protocol,
        method: spec.method ?? null,
        pathTemplate: spec.pathTemplate ?? null,
      },
    });
  }
  return id;
}

async function createEdge(prisma, tenantId, idsByName, spec) {
  const id = randomUUID();
  const fromNodeId = idsByName.get(spec.from);
  const toNodeId = idsByName.get(spec.to);
  await prisma.graphEdge.create({
    data: {
      id,
      tenantId,
      fromNodeId,
      toNodeId,
      edgeType: spec.edgeType,
      layer: EDGE_LAYER[spec.edgeType],
      provenance: 'human_authored',
      strength: HUMAN_AUTHORED_STRENGTH,
      confidence: FIXTURE_CONFIDENCE,
      state: 'confirmed',
      validFromVersion: 1,
    },
  });
  // edge_provenance is what graph_edge.strength/confidence are trigger-maintained as the MAXIMUM
  // over (T011) — a fixture edge carries one contributing observation, itself.
  await prisma.edgeProvenance.create({
    data: {
      id: randomUUID(),
      tenantId,
      edgeId: id,
      provenance: 'human_authored',
      strength: HUMAN_AUTHORED_STRENGTH,
      confidence: FIXTURE_CONFIDENCE,
      adapterKey: 'fixture',
      adapterVersion: 'v1',
    },
  });
}

async function loadFixture(prisma, fixture) {
  const { tenantId, nodes, edges } = fixture;
  // Delete-then-insert, FK-safe order: edge_provenance and graph_edge before graph_node (both
  // reference it), the kind-attr tables before graph_node (same), graph_version has no FK either
  // way.
  //
  // `edge_provenance` is append-only (T011: a trigger rejects DELETE outright) — the one
  // documented bypass is `SET LOCAL healer.privileged_write = 'on'` for the transaction that does
  // the delete (mirrors `@healer/prisma-client`'s `withPrivilegedWrite`, not imported here since
  // this plain-`node`-run script never depends on a workspace package needing a `dist/` build,
  // same reason as the generated-client import above).
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('healer.privileged_write', 'on', true)`;
    await tx.edgeProvenance.deleteMany({ where: { tenantId } });
  });
  await prisma.graphEdge.deleteMany({ where: { tenantId } });
  await prisma.componentAttr.deleteMany({ where: { tenantId } });
  await prisma.deploymentUnitAttr.deleteMany({ where: { tenantId } });
  await prisma.repositoryAttr.deleteMany({ where: { tenantId } });
  await prisma.endpointAttr.deleteMany({ where: { tenantId } });
  await prisma.graphNode.deleteMany({ where: { tenantId } });
  await prisma.graphVersion.deleteMany({ where: { tenantId } });

  await prisma.graphVersion.create({
    data: {
      id: randomUUID(),
      tenantId,
      version: 1,
      mintedBy: 'confirmation',
      actorRef: FIXTURE_ACTOR,
      note: 'graph-fixtures loader',
    },
  });

  const idsByName = new Map();
  for (const spec of nodes) {
    idsByName.set(spec.name, await createNode(prisma, tenantId, spec));
  }
  for (const spec of edges) {
    await createEdge(prisma, tenantId, idsByName, spec);
  }
}

// Quickstart #13: three components joined by `contains`, every one with its own `deploys` edge
// to ONE shared deployment unit (FR-002); all three `built_from` one repository — the monorepo
// half of quickstart #14 (FR-003).
export function monolithFixture() {
  return {
    tenantId: MONOLITH_TENANT_ID,
    nodes: [
      {
        nodeKind: 'component',
        name: 'api',
        componentType: 'service',
        characteristics: ['user_facing'],
      },
      {
        nodeKind: 'component',
        name: 'worker',
        componentType: 'worker',
        characteristics: ['scheduled'],
      },
      {
        nodeKind: 'component',
        name: 'frontend',
        componentType: 'frontend',
        characteristics: ['user_facing'],
      },
      {
        nodeKind: 'deployment_unit',
        name: 'monolith-app',
        environment: 'production',
        runtimeKind: 'container',
        runtimeRef: 'monolith-app-deployment',
      },
      {
        nodeKind: 'repository',
        name: 'monorepo',
        vcs: 'gitlab',
        projectRef: 'design-partner/monorepo',
        defaultBranch: 'main',
      },
      {
        nodeKind: 'endpoint',
        name: 'api-route',
        protocol: 'http',
        method: 'GET',
        pathTemplate: '/api',
      },
    ],
    edges: [
      { from: 'api', to: 'worker', edgeType: 'contains' },
      { from: 'api', to: 'frontend', edgeType: 'contains' },
      { from: 'api', to: 'monolith-app', edgeType: 'deploys' },
      { from: 'worker', to: 'monolith-app', edgeType: 'deploys' },
      { from: 'frontend', to: 'monolith-app', edgeType: 'deploys' },
      { from: 'api', to: 'monorepo', edgeType: 'built_from' },
      { from: 'worker', to: 'monorepo', edgeType: 'built_from' },
      { from: 'frontend', to: 'monorepo', edgeType: 'built_from' },
      { from: 'api-route', to: 'api', edgeType: 'implements' },
      { from: 'monolith-app', to: 'api-route', edgeType: 'exposes' },
    ],
  };
}

// Independent components, each with its OWN deployment unit and repository, `calls`/`depends_on`
// between them; `payments` is `built_from` two repositories — the multi-repo half of
// quickstart #14 (FR-003).
export function microservicesFixture() {
  return {
    tenantId: MICROSERVICES_TENANT_ID,
    nodes: [
      { nodeKind: 'component', name: 'orders', componentType: 'service' },
      { nodeKind: 'component', name: 'payments', componentType: 'service' },
      { nodeKind: 'component', name: 'shipping', componentType: 'service' },
      {
        nodeKind: 'deployment_unit',
        name: 'orders-du',
        environment: 'production',
        runtimeKind: 'container',
        runtimeRef: 'orders-deployment',
      },
      {
        nodeKind: 'deployment_unit',
        name: 'payments-du',
        environment: 'production',
        runtimeKind: 'container',
        runtimeRef: 'payments-deployment',
      },
      {
        nodeKind: 'deployment_unit',
        name: 'shipping-du',
        environment: 'production',
        runtimeKind: 'container',
        runtimeRef: 'shipping-deployment',
      },
      {
        nodeKind: 'repository',
        name: 'orders-repo',
        vcs: 'gitlab',
        projectRef: 'design-partner/orders',
        defaultBranch: 'main',
      },
      {
        nodeKind: 'repository',
        name: 'payments-repo',
        vcs: 'gitlab',
        projectRef: 'design-partner/payments',
        defaultBranch: 'main',
      },
      {
        nodeKind: 'repository',
        name: 'payments-shared-repo',
        vcs: 'gitlab',
        projectRef: 'design-partner/payments-shared-lib',
        defaultBranch: 'main',
      },
      {
        nodeKind: 'repository',
        name: 'shipping-repo',
        vcs: 'gitlab',
        projectRef: 'design-partner/shipping',
        defaultBranch: 'main',
      },
      {
        nodeKind: 'endpoint',
        name: 'orders-route',
        protocol: 'http',
        method: 'GET',
        pathTemplate: '/orders',
      },
    ],
    edges: [
      { from: 'orders', to: 'orders-du', edgeType: 'deploys' },
      { from: 'payments', to: 'payments-du', edgeType: 'deploys' },
      { from: 'shipping', to: 'shipping-du', edgeType: 'deploys' },
      { from: 'orders', to: 'orders-repo', edgeType: 'built_from' },
      { from: 'payments', to: 'payments-repo', edgeType: 'built_from' },
      { from: 'payments', to: 'payments-shared-repo', edgeType: 'built_from' },
      { from: 'shipping', to: 'shipping-repo', edgeType: 'built_from' },
      { from: 'orders', to: 'payments', edgeType: 'calls' },
      { from: 'orders', to: 'shipping', edgeType: 'depends_on' },
      { from: 'orders-route', to: 'orders', edgeType: 'implements' },
      { from: 'orders-du', to: 'orders-route', edgeType: 'exposes' },
    ],
  };
}

// A mix: two `function`-runtime deployment units alongside one traditional, container-deployed
// component, all built the same way — the model must not special-case serverless.
export function serverlessFixture() {
  return {
    tenantId: SERVERLESS_TENANT_ID,
    nodes: [
      { nodeKind: 'component', name: 'checkout-api', componentType: 'service' },
      {
        nodeKind: 'component',
        name: 'send-email-fn',
        componentType: 'service',
        characteristics: ['event_driven'],
      },
      {
        nodeKind: 'component',
        name: 'resize-image-fn',
        componentType: 'service',
        characteristics: ['event_driven'],
      },
      {
        nodeKind: 'deployment_unit',
        name: 'checkout-container',
        environment: 'production',
        runtimeKind: 'container',
        runtimeRef: 'checkout-api-deployment',
      },
      {
        nodeKind: 'deployment_unit',
        name: 'send-email-function',
        environment: 'production',
        runtimeKind: 'function',
        runtimeRef: 'send-email-lambda',
      },
      {
        nodeKind: 'deployment_unit',
        name: 'resize-image-function',
        environment: 'production',
        runtimeKind: 'function',
        runtimeRef: 'resize-image-lambda',
      },
      {
        nodeKind: 'repository',
        name: 'serverless-workloads',
        vcs: 'gitlab',
        projectRef: 'design-partner/serverless-workloads',
        defaultBranch: 'main',
      },
      {
        nodeKind: 'endpoint',
        name: 'checkout-route',
        protocol: 'http',
        method: 'POST',
        pathTemplate: '/checkout',
      },
    ],
    edges: [
      { from: 'checkout-api', to: 'checkout-container', edgeType: 'deploys' },
      { from: 'send-email-fn', to: 'send-email-function', edgeType: 'deploys' },
      { from: 'resize-image-fn', to: 'resize-image-function', edgeType: 'deploys' },
      { from: 'checkout-api', to: 'serverless-workloads', edgeType: 'built_from' },
      { from: 'send-email-fn', to: 'serverless-workloads', edgeType: 'built_from' },
      { from: 'resize-image-fn', to: 'serverless-workloads', edgeType: 'built_from' },
      { from: 'checkout-api', to: 'send-email-fn', edgeType: 'calls' },
      { from: 'checkout-route', to: 'checkout-api', edgeType: 'implements' },
      { from: 'checkout-container', to: 'checkout-route', edgeType: 'exposes' },
    ],
  };
}

export async function loadAllFixtures(prisma) {
  await loadFixture(prisma, monolithFixture());
  await loadFixture(prisma, microservicesFixture());
  await loadFixture(prisma, serverlessFixture());
}

if (isMainModule(import.meta.url)) {
  const prisma = new PrismaClient();
  try {
    await loadAllFixtures(prisma);
    process.stdout.write(
      `graph-fixtures: monolith (${MONOLITH_TENANT_ID}), microservices (${MICROSERVICES_TENANT_ID}), serverless (${SERVERLESS_TENANT_ID}) loaded\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
