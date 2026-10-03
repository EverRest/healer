import {
  Controller,
  Get,
  Headers,
  Inject,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import type { BoundaryRejection, BoundaryRejectionRepository } from '@healer/domain-context';
import { scope } from '@healer/shared';
import { resolveTenant } from '../policy/policy-http.js';
import { boundaryRejectionsQuerySchema } from './boundary-rejections.dto.js';

export const BOUNDARY_REJECTION_REPOSITORY = Symbol('BOUNDARY_REJECTION_REPOSITORY');

function serialize(r: BoundaryRejection) {
  return {
    id: r.id,
    runnerId: r.runnerId,
    passId: r.passId ?? null,
    contractVersion: r.contractVersion,
    schemaErrorPaths: r.schemaErrorPaths,
    payloadDigest: r.payloadDigest,
    byteSize: r.byteSize,
    receivedAt: r.receivedAt,
  };
}

/**
 * `GET /boundary-rejections` (003 T030, FR-010, quickstart 35): the inbound payloads the boundary
 * schema refused, and their counts, visible to the tenant that sent them. Paths, a digest and a
 * size — there is nothing else to show (R-13). A list, so another tenant's rows are simply absent;
 * the tenant comes from the authenticated context and reaches the query layer, never a post-filter.
 */
@Controller('boundary-rejections')
export class BoundaryRejectionsController {
  constructor(
    @Inject(BOUNDARY_REJECTION_REPOSITORY) private readonly rejections: BoundaryRejectionRepository,
  ) {}

  @Get()
  @ApiQuery({ name: 'runnerId', required: false, type: String })
  @ApiQuery({ name: 'since', required: false, type: String })
  async list(
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Query() query: Record<string, unknown> = {},
  ) {
    const context = resolveTenant(tenantIdHeader);
    const parsed = boundaryRejectionsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `invalid query: ${parsed.error.issues[0]?.path.join('.') ?? 'malformed'}`,
      );
    }
    const { runnerId, since } = parsed.data;
    const summary = await this.rejections.list(
      scope(context, {
        ...(runnerId !== undefined ? { runnerId } : {}),
        ...(since !== undefined ? { since: new Date(since) } : {}),
      }),
    );
    return {
      items: summary.items.map(serialize),
      total: summary.total,
      countsByRunner: summary.countsByRunner,
    };
  }
}
