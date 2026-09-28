import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type {
  EvidenceGraph,
  EvidenceGraphRepository,
  EvidenceRepository,
  EvidenceType,
} from '@healer/domain-evidence';
import {
  ConcurrentModificationError,
  InvalidIssueTransitionError,
  closeIssue,
  projectIssueRelationships,
  type AuditRepository,
  type Issue,
  type IssueRelationship,
  type IssueRepository,
  type TimelineEntry,
  type TimelineRepository,
} from '@healer/domain-issues';
import {
  NotFoundError,
  TenantContext,
  TenantIsolationError,
  newCorrelationId,
  scope,
  withCorrelation,
} from '@healer/shared';
import { closeIssueRequestSchema } from './close-issue.dto.js';

export const ISSUE_REPOSITORY = Symbol('ISSUE_REPOSITORY');
export const EVIDENCE_REPOSITORY = Symbol('EVIDENCE_REPOSITORY');
export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
export const TIMELINE_REPOSITORY = Symbol('TIMELINE_REPOSITORY');
export const EVIDENCE_GRAPH_REPOSITORY = Symbol('EVIDENCE_GRAPH_REPOSITORY');

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

const MAX_ACTOR_LENGTH = 128;

/**
 * `GET /issues`, `GET /issues/{issueId}` and `GET /issues/{issueId}/evidence` (001 T031/T040,
 * FR-001, FR-007, FR-020, SC-004), plus `/timeline`, `/evidence-graph`, `/audit` and
 * `POST /close` (001 T044/T048/T057, FR-012, FR-013, FR-021). Every single-issue lookup checks tenant ownership *first* — a
 * cross-tenant `issueId` must 404 the same way a nonexistent one does, never fall through to a
 * query that would just return nothing (SC-004: 404 on every one of another tenant's resources,
 * never 403, which would itself confirm the `issueId` exists).
 */
@Controller('issues')
export class IssuesController {
  constructor(
    @Inject(ISSUE_REPOSITORY) private readonly issues: IssueRepository,
    @Inject(EVIDENCE_REPOSITORY) private readonly evidence: EvidenceRepository,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(TIMELINE_REPOSITORY) private readonly timeline: TimelineRepository,
    @Inject(EVIDENCE_GRAPH_REPOSITORY) private readonly evidenceGraph: EvidenceGraphRepository,
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

  @Get(':issueId/audit')
  async listAudit(
    @Param('issueId') issueId: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ items: readonly unknown[] }> {
    const context = this.resolveTenant(tenantIdHeader);

    const issue = await this.issues.findById(scope(context, { id: issueId }));
    if (issue === null) {
      throw new NotFoundException(`issue ${issueId} not found`);
    }

    const entries = await this.audit.listByTarget(
      scope(context, { targetType: 'issue', targetId: issueId }),
    );
    // SC-007: every agent-action entry resolves to a retrievable prompt version and model
    // identifier — resolved inline here, not stored a second time on the entry (C-13).
    const items = await Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        ...(entry.agentRunId !== undefined
          ? {
              agentRunFacts: await this.audit.resolveAgentRunFacts(
                scope(context, { agentRunId: entry.agentRunId }),
              ),
            }
          : {}),
      })),
    );
    return { items };
  }

  /** 404 unless the issue exists *under the caller's tenant* — the timeline and graph
   *  repositories return an empty view for an unknown id, which would itself confirm nothing
   *  and read as a real issue with no history (SC-004). */
  private async requireIssue(context: TenantContext, issueId: string): Promise<Issue> {
    const issue = await this.issues.findById(scope(context, { id: issueId }));
    if (issue === null) {
      throw new NotFoundException(`issue ${issueId} not found`);
    }
    return issue;
  }

  @Get(':issueId/timeline')
  async getTimeline(
    @Param('issueId') issueId: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ items: readonly TimelineEntry[] }> {
    const context = this.resolveTenant(tenantIdHeader);
    await this.requireIssue(context, issueId);
    return { items: await this.timeline.forIssue(scope(context, { issueId })) };
  }

  @Get(':issueId/evidence-graph')
  async getEvidenceGraph(
    @Param('issueId') issueId: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<EvidenceGraph> {
    const context = this.resolveTenant(tenantIdHeader);
    await this.requireIssue(context, issueId);
    return this.evidenceGraph.forIssue(scope(context, { issueId }));
  }

  /**
   * A human closes the issue (001 T057, FR-021, C-09, quickstart 27): `resolved` with
   * `IssueResolved(self_resolved)` and no verification evidence. Nothing here can label it
   * otherwise — the repository derives the kind from the human cause.
   *
   * Identity: no credential is verified yet (see `resolveTenant`), so there is no authenticated
   * user to record. `X-Actor-Id` is a caller-asserted stub of the same standing as `X-Tenant-Id`:
   * required, so an anonymous close cannot be recorded as if someone did it, and replaced by the
   * authenticated subject when real auth lands (QUESTIONS.md "001 T057").
   *
   * `Idempotency-Key` is required and validated per the contract but not stored: closing is
   * idempotent by state (`closeIssue`), so any repeat — same key, new key, concurrent — is a
   * 200 that changes nothing. The contract's "same key with a different body is 409" is not
   * implemented (QUESTIONS.md).
   */
  @Post(':issueId/close')
  @HttpCode(200)
  @ApiOkResponse({
    description:
      'The resolved issue. A close that changed nothing (already resolved, or another close won ' +
      'the race) is also a 200 and is marked with `Idempotent-Replay: true`; its actor and reason ' +
      'were not recorded. 400: missing/invalid Idempotency-Key (uuid), X-Actor-Id (1-128) or ' +
      'reason (1-1000). 404: unknown issue or another tenant. 409: merged or removed.',
    headers: {
      'Idempotent-Replay': {
        description: 'Present (`true`) only when this request closed nothing',
        schema: { type: 'string', enum: ['true'] },
      },
    },
  })
  async close(
    @Param('issueId') issueId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('x-actor-id') actorIdHeader?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    const context = this.resolveTenant(tenantIdHeader);

    if (idempotencyKey === undefined || !UUID_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key header is required and must be a UUID');
    }
    const actor = actorIdHeader?.trim() ?? '';
    if (actor === '' || actor.length > MAX_ACTOR_LENGTH) {
      throw new BadRequestException(
        `X-Actor-Id header is required (1-${MAX_ACTOR_LENGTH} characters)`,
      );
    }
    const parsed = closeIssueRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(`invalid close request: ${parsed.error.issues[0]?.message}`);
    }

    try {
      const { issue, closed } = await withCorrelation(newCorrelationId(), () =>
        closeIssue(this.issues, context, issueId, actor, parsed.data.reason),
      );
      // The request did not close anything: say so, so a second closer is not left believing its
      // actor and reason were recorded (they were not — the original close stands).
      if (!closed) response.setHeader('Idempotent-Replay', 'true');
      return serializeIssue(
        issue,
        await this.issues.findRelationships(scope(context, { id: issueId })),
      );
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`issue ${issueId} not found`);
      }
      if (
        error instanceof InvalidIssueTransitionError ||
        error instanceof ConcurrentModificationError
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}
