import { NotFoundError, type TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import type { GraphStructureRepository } from '../domain/graph-structure-repository.js';
import type { NodeKind } from '../domain/graph-vocabulary.js';
import type {
  ComponentAttrValue,
  DeploymentUnitAttrValue,
  EndpointAttrValue,
  RepositoryAttrValue,
  Validated,
} from '../domain/kind-attributes.js';
import { findEdgeViolations, type EdgeViolation } from '../domain/structural-edges.js';

const OPEN = 2147483647; // valid_to_version of a current row (R-04)

type ByNode = TenantScoped<{ readonly nodeId: string }>;

export class PrismaGraphStructureRepository implements GraphStructureRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** The node must exist in THIS tenant and be of `kind` — anything else is not-found (FR-024). */
  private async assertNode(where: ByNode, kind: NodeKind): Promise<void> {
    const node = await this.prisma.graphNode.findFirst({
      where: { id: where.nodeId, tenantId: where.tenantId, nodeKind: kind },
      select: { id: true },
    });
    if (node === null) throw new NotFoundError('GraphNode');
  }

  async getComponentAttr(where: ByNode): Promise<ComponentAttrValue> {
    const row = await this.prisma.componentAttr.findFirst({
      where: { nodeId: where.nodeId, tenantId: where.tenantId },
    });
    if (row === null) throw new NotFoundError('ComponentAttr');
    return {
      componentType: row.componentType,
      characteristics: row.characteristics,
      ownerRef: row.ownerRef,
    };
  }

  async getDeploymentUnitAttr(where: ByNode): Promise<DeploymentUnitAttrValue> {
    const row = await this.prisma.deploymentUnitAttr.findFirst({
      where: { nodeId: where.nodeId, tenantId: where.tenantId },
    });
    if (row === null) throw new NotFoundError('DeploymentUnitAttr');
    return {
      environment: row.environment,
      runtimeKind: row.runtimeKind,
      runtimeRef: row.runtimeRef,
      currentVersion: row.currentVersion,
    };
  }

  async getRepositoryAttr(where: ByNode): Promise<RepositoryAttrValue> {
    const row = await this.prisma.repositoryAttr.findFirst({
      where: { nodeId: where.nodeId, tenantId: where.tenantId },
    });
    if (row === null) throw new NotFoundError('RepositoryAttr');
    return { vcs: row.vcs, projectRef: row.projectRef, defaultBranch: row.defaultBranch };
  }

  async getEndpointAttr(where: ByNode): Promise<EndpointAttrValue> {
    const row = await this.prisma.endpointAttr.findFirst({
      where: { nodeId: where.nodeId, tenantId: where.tenantId },
    });
    if (row === null) throw new NotFoundError('EndpointAttr');
    return {
      protocol: row.protocol,
      method: row.method,
      pathTemplate: row.pathTemplate,
      contractRef: row.contractRef,
    };
  }

  async saveComponentAttr(where: ByNode, attr: Validated<ComponentAttrValue>): Promise<void> {
    await this.assertNode(where, 'component');
    const data = { ...attr, characteristics: [...attr.characteristics] };
    await this.prisma.componentAttr.upsert({
      where: { nodeId_tenantId: { nodeId: where.nodeId, tenantId: where.tenantId } },
      create: { nodeId: where.nodeId, tenantId: where.tenantId, ...data },
      update: data,
    });
  }

  async saveDeploymentUnitAttr(
    where: ByNode,
    attr: Validated<DeploymentUnitAttrValue>,
  ): Promise<void> {
    await this.assertNode(where, 'deployment_unit');
    await this.prisma.deploymentUnitAttr.upsert({
      where: { nodeId_tenantId: { nodeId: where.nodeId, tenantId: where.tenantId } },
      create: { nodeId: where.nodeId, tenantId: where.tenantId, ...attr },
      update: { ...attr },
    });
  }

  async saveRepositoryAttr(where: ByNode, attr: Validated<RepositoryAttrValue>): Promise<void> {
    await this.assertNode(where, 'repository');
    await this.prisma.repositoryAttr.upsert({
      where: { nodeId_tenantId: { nodeId: where.nodeId, tenantId: where.tenantId } },
      create: { nodeId: where.nodeId, tenantId: where.tenantId, ...attr },
      update: { ...attr },
    });
  }

  async saveEndpointAttr(where: ByNode, attr: Validated<EndpointAttrValue>): Promise<void> {
    await this.assertNode(where, 'endpoint');
    await this.prisma.endpointAttr.upsert({
      where: { nodeId_tenantId: { nodeId: where.nodeId, tenantId: where.tenantId } },
      create: { nodeId: where.nodeId, tenantId: where.tenantId, ...attr },
      update: { ...attr },
    });
  }

  async listEdgeEndpointViolations(where: TenantScoped<object>): Promise<EdgeViolation[]> {
    const edges = await this.prisma.graphEdge.findMany({
      where: { tenantId: where.tenantId, validToVersion: OPEN },
      include: { fromNode: true, toNode: true },
    });
    return findEdgeViolations(
      edges.flatMap((e) => [
        { id: e.fromNodeId, kind: e.fromNode.nodeKind },
        { id: e.toNodeId, kind: e.toNode.nodeKind },
      ]),
      edges.map((e) => ({ type: e.edgeType, from: e.fromNodeId, to: e.toNodeId })),
    );
  }
}
