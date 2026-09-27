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
import type { EvidenceRepository, EvidenceType } from '@healer/domain-evidence';
import type { IssueRepository } from '@healer/domain-issues';
import { TenantContext, TenantIsolationError, scope } from '@healer/shared';

export const ISSUE_REPOSITORY = Symbol('ISSUE_REPOSITORY');
export const EVIDENCE_REPOSITORY = Symbol('EVIDENCE_REPOSITORY');

/** The one authority for which `type` query values this endpoint accepts — mirrors
 *  `EvidenceType` exactly, kept as a runtime list since the type itself erases at build time. */
const EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  'error_signature',
  'trace_shape',
  'metric_delta',
  'deploy_ref',
  'commit_ref',
  'test_result',
  'file_path',
  'tool_output_summary',
  'document_excerpt',
  'collection_gap',
  'budget_degradation',
  'graph_fact',
]);

/**
 * `GET /issues/{issueId}/evidence` (001 T031, FR-007, SC-004). The issue is looked up under the
 * caller's own tenant *first* — a cross-tenant `issueId` must 404 the same way a nonexistent one
 * does, never fall through to an evidence query that would just return an empty list (SC-004:
 * 404 on every one of another tenant's resources, never 403, which would itself confirm the
 * `issueId` exists).
 */
@Controller('issues')
export class IssuesController {
  constructor(
    @Inject(ISSUE_REPOSITORY) private readonly issues: IssueRepository,
    @Inject(EVIDENCE_REPOSITORY) private readonly evidence: EvidenceRepository,
  ) {}

  @Get(':issueId/evidence')
  async listEvidence(
    @Param('issueId') issueId: string,
    @Query('type') type: string | undefined,
    // Same deliberate, TODO-flagged stub-auth pattern as IngestController (001 T019) — no
    // `ingestBearer`-equivalent credential is verified yet.
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ items: readonly unknown[] }> {
    let context: TenantContext;
    try {
      context = TenantContext.forTrustedInternalUse(tenantIdHeader ?? '');
    } catch (error) {
      if (error instanceof TenantIsolationError) {
        throw new BadRequestException('X-Tenant-Id header is missing or not a valid tenant id');
      }
      throw error;
    }

    if (type !== undefined && !EVIDENCE_TYPES.has(type)) {
      throw new BadRequestException(`"${type}" is not a recognized evidence type`);
    }

    const issue = await this.issues.findById(scope(context, { id: issueId }));
    if (issue === null) {
      throw new NotFoundException(`issue ${issueId} not found`);
    }

    const items = await this.evidence.listByIssue(
      scope(context, { issueId, ...(type !== undefined ? { type: type as EvidenceType } : {}) }),
    );
    return { items };
  }
}
