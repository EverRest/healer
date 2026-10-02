import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  InvalidGraphFilterError,
  type GraphReadRepository,
  type ReadEnvelope,
} from '@healer/domain-architecture';
import { NotFoundError, scope } from '@healer/shared';
import { resolveTenant, UUID_PATTERN } from '../policy/policy-http.js';
import { graphNodeQuerySchema, graphVersionSchema } from './graph-nodes.dto.js';

export const GRAPH_READ_REPOSITORY = Symbol('GRAPH_READ_REPOSITORY');

/**
 * `GET /graph/nodes` and `GET /graph/nodes/{nodeId}` (004 T041, FR-006). Thin: tenant from the
 * auth context (never a query parameter), the query validated, one call to the read repository.
 * Both answers are the read envelope (R-13). A node of another tenant is a 404, never a 403 —
 * a 403 would confirm it exists (FR-024).
 */
@Controller('graph/nodes')
export class GraphNodesController {
  constructor(@Inject(GRAPH_READ_REPOSITORY) private readonly graph: GraphReadRepository) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<ReadEnvelope<unknown>> {
    const context = resolveTenant(tenantIdHeader);
    const parsed = graphNodeQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(
        `invalid query: ${parsed.error.issues[0]?.message ?? 'malformed'}`,
      );
    }
    try {
      return await this.graph.listNodes(scope(context, parsed.data));
    } catch (error) {
      if (error instanceof InvalidGraphFilterError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get(':nodeId')
  async get(
    @Param('nodeId') nodeId: string,
    @Query('graphVersion') graphVersionRaw?: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<Omit<ReadEnvelope<unknown>, 'items'> & { node: unknown; edges: unknown }> {
    const context = resolveTenant(tenantIdHeader);
    const graphVersion = graphVersionSchema.safeParse(graphVersionRaw);
    if (!graphVersion.success) throw new BadRequestException('graphVersion must be an integer');
    if (!UUID_PATTERN.test(nodeId)) throw new NotFoundException(`node ${nodeId} not found`);
    try {
      // contracts/openapi.yaml: the envelope fields plus `node` and `edges` at the top level.
      const { items, ...envelope } = await this.graph.getNode(
        scope(context, {
          id: nodeId,
          ...(graphVersion.data !== undefined ? { graphVersion: graphVersion.data } : {}),
        }),
      );
      return { ...envelope, node: items.node, edges: items.edges };
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundException(`node ${nodeId} not found`);
      throw error;
    }
  }
}
