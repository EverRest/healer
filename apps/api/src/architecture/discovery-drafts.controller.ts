import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  confirmDraftItems,
  rejectDraftItems,
  GRAPH_CONFIRM_CAPABILITY,
  GraphConcurrencyError,
  type DiscoveryRepository,
  type DraftItemRow,
  type DraftReviewRepository,
} from '@healer/domain-architecture';
import {
  HealerError,
  NotFoundError,
  httpStatusFor,
  newCorrelationId,
  scope,
  withCorrelation,
} from '@healer/shared';
import { requireIdempotencyKey, resolveGraphReviewActor, resolveTenant } from './discovery-http.js';
import { DISCOVERY_REPOSITORY } from './discovery-runs.controller.js';

export const DRAFT_REVIEW_REPOSITORY = Symbol('DRAFT_REVIEW_REPOSITORY');

const UUID_SCHEMA = z.string().uuid();

/** `POST /discovery/drafts/{draftId}/confirm` body — `note` is optional free text, bounded like
 *  every other such field in this codebase (R-05). Declared here, not in `discovery.dto.ts`, so
 *  the one file that genuinely references `GRAPH_CONFIRM_CAPABILITY` is also the one carrying
 *  every confirm-shaped identifier (see that file's own comment). */
const confirmDraftItemsRequestSchema = z
  .object({
    itemIds: z.array(UUID_SCHEMA).min(1),
    note: z.string().trim().max(1000).optional().default(''),
  })
  .strict();

/** `POST /discovery/drafts/{draftId}/reject` body — `reason` is required, same posture as
 *  `IssuesController.close`'s own reason field (FR-011: a rejection with no "why" loses the point
 *  of recording it at all). */
const rejectDraftItemsRequestSchema = z
  .object({
    itemIds: z.array(UUID_SCHEMA).min(1),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

function serializeDraftItem(item: DraftItemRow) {
  return {
    id: item.id,
    op: item.op,
    targetNodeId: item.targetNodeId,
    targetEdgeId: item.targetEdgeId,
    proposed: item.proposed,
    current: item.current,
    proposalDigest: item.proposalDigest,
    state: item.state,
    provenance: {
      class: item.provenance,
      strength: item.strength,
      confidence: item.confidence,
      observationRef: item.observationRef,
    },
  };
}

function throwMapped(error: unknown, notFoundMessage: string): never {
  if (error instanceof NotFoundError) {
    throw new NotFoundException(notFoundMessage);
  }
  if (error instanceof HealerError) {
    throw new HttpException(error.toBody(), httpStatusFor(error.code));
  }
  // `GraphConcurrencyError` is a plain `Error`, not a `HealerError` (its own doc comment: "the
  // caller's own re-read and retry is the correct response, not something this error attempts on
  // the caller's behalf") — without this, a genuine version-mint race would have surfaced as an
  // opaque 500 instead of a 409 a caller can sensibly retry against, same posture as
  // `PolicyRulesetsController`'s own `StaleRulesetVersionError` → `ConflictException` mapping.
  if (error instanceof GraphConcurrencyError) {
    throw new ConflictException(error.message);
  }
  throw error;
}

/**
 * `GET /discovery/drafts/{draftId}`, `/confirm`, `/reject` (T033, FR-009, FR-010, FR-011).
 *
 * Thin by rule (`.claude/rules/backend-nestjs.md`): every real decision — the human-actor gate,
 * the supersede rebase, the one-graph-version-per-batch guarantee — lives in
 * `confirmDraftItems`/`rejectDraftItems` (`packages/domain/architecture/src/application/`), not
 * here. This controller's own job is translating the request (tenant, actor, idempotency, body)
 * and the result (success or `HealerError`) across the HTTP boundary.
 *
 * **Defense in depth, not a second enforcement point**: this file is the real confirm/reject
 * surface `scripts/gates/graph-confirm-capability.mjs` now expects to see in `apps/api/src` (it
 * moved out of that gate's strict "nothing here may look like one yet" root once Phase 3 landed
 * a real route — see that file's own updated header). `GRAPH_CONFIRM_CAPABILITY` is referenced
 * directly below, right where the confirm/reject handlers dispatch, as a readable assertion that
 * this *is* the capability-gated surface — the actual gate is `requireHumanReviewActor`, called
 * inside `confirmDraftItems`/`rejectDraftItems` themselves, which already refuses every non-human
 * actor before any write (R-09); this reference does not duplicate that check.
 */
@Controller('discovery/drafts')
export class DiscoveryDraftsController {
  constructor(
    @Inject(DISCOVERY_REPOSITORY) private readonly discovery: DiscoveryRepository,
    @Inject(DRAFT_REVIEW_REPOSITORY) private readonly draftReview: DraftReviewRepository,
  ) {}

  @Get(':draftId')
  async getOne(
    @Param('draftId') draftId: string,
    @Query('op') op: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    const draft = await this.discovery.getDraft(
      scope(context, { draftId, ...(op !== undefined ? { op } : {}) }),
    );
    if (draft === null) {
      throw new NotFoundException(`draft ${draftId} not found`);
    }
    return {
      draftId: draft.draftId,
      baseVersion: draft.baseVersion,
      state: draft.state,
      items: draft.items.map(serializeDraftItem),
    };
  }

  /** `GRAPH_CONFIRM_CAPABILITY`-gated route (FR-010, R-09) — see this class's own doc comment. */
  @Post(':draftId/confirm')
  @HttpCode(200)
  async confirm(
    @Param('draftId') draftId: string,
    @Body() body: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('x-actor-type') actorTypeHeader?: string,
    @Headers('x-actor-id') actorIdHeader?: string,
    @Headers('x-agent-run-id') agentRunIdHeader?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    void GRAPH_CONFIRM_CAPABILITY; // this route is what that capability gates (FR-010, R-09)
    const context = resolveTenant(tenantIdHeader);
    requireIdempotencyKey(idempotencyKey);
    const actor = resolveGraphReviewActor(actorTypeHeader, actorIdHeader, agentRunIdHeader);

    const parsed = confirmDraftItemsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { code: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'invalid request' },
        httpStatusFor('VALIDATION'),
      );
    }

    try {
      const result = await withCorrelation(newCorrelationId(), () =>
        confirmDraftItems(this.draftReview, context, {
          draftId,
          itemIds: parsed.data.itemIds,
          actor,
          reason: parsed.data.note,
        }),
      );
      return { version: result.version, confirmedItems: result.confirmedItems };
    } catch (error) {
      throwMapped(error, `draft ${draftId} not found`);
    }
  }

  /** `GRAPH_CONFIRM_CAPABILITY`-gated route (FR-010, R-09) — rejection is decided by the same
   *  human-actor gate as confirmation, see this class's own doc comment. */
  @Post(':draftId/reject')
  @HttpCode(200)
  async reject(
    @Param('draftId') draftId: string,
    @Body() body: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('x-actor-type') actorTypeHeader?: string,
    @Headers('x-actor-id') actorIdHeader?: string,
    @Headers('x-agent-run-id') agentRunIdHeader?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    void GRAPH_CONFIRM_CAPABILITY; // this route is what that capability gates (FR-010, R-09)
    const context = resolveTenant(tenantIdHeader);
    requireIdempotencyKey(idempotencyKey);
    const actor = resolveGraphReviewActor(actorTypeHeader, actorIdHeader, agentRunIdHeader);

    const parsed = rejectDraftItemsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { code: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'invalid request' },
        httpStatusFor('VALIDATION'),
      );
    }

    try {
      const result = await withCorrelation(newCorrelationId(), () =>
        rejectDraftItems(this.draftReview, context, {
          draftId,
          itemIds: parsed.data.itemIds,
          actor,
          reason: parsed.data.reason,
        }),
      );
      return { rejectedItemIds: result.rejectedItemIds };
    } catch (error) {
      throwMapped(error, `draft ${draftId} not found`);
    }
  }
}
