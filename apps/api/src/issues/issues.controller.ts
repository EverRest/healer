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
import {
  projectIssueRelationships,
  type Issue,
  type IssueRelationship,
  type IssueRepository,
} from '@healer/domain-issues';
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

/** Mirrors `IssueState` (001 T040) — same reasoning as `EVIDENCE_TYPES`. */
const ISSUE_STATES: ReadonlySet<string> = new Set([
  'detected',
  'investigating',
  'diagnosed',
  'acting',
  'resolved',
  'needs_human',
  'stale',
  'merged',
  'removed',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `contracts/openapi.yaml`'s `Issue` schema: `occurrenceCount` is a plain JSON `integer`, never
 *  the domain's own `bigint` — Express's `res.json` (`JSON.stringify`) throws on a raw bigint,
 *  the same class of bug 001 T025 already found and fixed for a BullMQ job's return value. */
function serializeIssue(issue: Issue, relationships: readonly IssueRelationship[]) {
  return {
    id: issue.id,
    kind: issue.kind,
    componentId: issue.componentId,
    environment: issue.environment,
    severity: issue.severity,
    state: issue.state,
    fingerprint: issue.fingerprint,
    rulesetVersion: issue.rulesetVersion,
    occurrenceCount: Number(issue.occurrenceCount),
    firstSeenAt: issue.firstSeenAt,
    lastSeenAt: issue.lastSeenAt,
    ...projectIssueRelationships(issue.id, relationships),
  };
}

/**
 * `GET /issues`, `GET /issues/{issueId}` and `GET /issues/{issueId}/evidence` (001 T031/T040,
 * FR-001, FR-007, FR-020, SC-004). Every single-issue lookup checks tenant ownership *first* — a
 * cross-tenant `issueId` must 404 the same way a nonexistent one does, never fall through to a
 * query that would just return nothing (SC-004: 404 on every one of another tenant's resources,
 * never 403, which would itself confirm the `issueId` exists).
 */
@Controller('issues')
export class IssuesController {
  constructor(
    @Inject(ISSUE_REPOSITORY) private readonly issues: IssueRepository,
    @Inject(EVIDENCE_REPOSITORY) private readonly evidence: EvidenceRepository,
  ) {}

  // Same deliberate, TODO-flagged stub-auth pattern as IngestController (001 T019) — no
  // `ingestBearer`-equivalent credential is verified yet.
  private resolveTenant(tenantIdHeader: string | undefined): TenantContext {
    try {
      return TenantContext.forTrustedInternalUse(tenantIdHeader ?? '');
    } catch (error) {
      if (error instanceof TenantIsolationError) {
        throw new BadRequestException('X-Tenant-Id header is missing or not a valid tenant id');
      }
      throw error;
    }
  }

  @Get()
  async list(
    @Query('state') state: string | undefined,
    @Query('componentId') componentId: string | undefined,
    @Query('since') since: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ items: readonly unknown[] }> {
    const context = this.resolveTenant(tenantIdHeader);

    if (state !== undefined && !ISSUE_STATES.has(state)) {
      throw new BadRequestException(`"${state}" is not a recognized issue state`);
    }
    if (componentId !== undefined && !UUID_PATTERN.test(componentId)) {
      throw new BadRequestException(`"${componentId}" is not a valid componentId`);
    }
    let sinceDate: Date | undefined;
    if (since !== undefined) {
      sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        throw new BadRequestException(`"${since}" is not a valid date-time`);
      }
    }

    const found = await this.issues.list(
      scope(context, {
        ...(state !== undefined ? { state: state as Issue['state'] } : {}),
        ...(componentId !== undefined ? { componentId } : {}),
        ...(sinceDate !== undefined ? { since: sinceDate } : {}),
      }),
    );
    // One relationship fetch per issue, in parallel — not batched into a single query, since
    // no list in this codebase has needed that yet (YAGNI); revisit if a real list grows large
    // enough for N+1 to actually show up in a profile.
    const items = await Promise.all(
      found.map(async (issue) =>
        serializeIssue(
          issue,
          await this.issues.findRelationships(scope(context, { id: issue.id })),
        ),
      ),
    );
    return { items };
  }

  @Get(':issueId')
  async getOne(
    @Param('issueId') issueId: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<unknown> {
    const context = this.resolveTenant(tenantIdHeader);
    const issue = await this.issues.findById(scope(context, { id: issueId }));
    if (issue === null) {
      throw new NotFoundException(`issue ${issueId} not found`);
    }
    const relationships = await this.issues.findRelationships(scope(context, { id: issueId }));
    return serializeIssue(issue, relationships);
  }

  @Get(':issueId/evidence')
  async listEvidence(
    @Param('issueId') issueId: string,
    @Query('type') type: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ items: readonly unknown[] }> {
    const context = this.resolveTenant(tenantIdHeader);

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
