import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  GRAPH_CONFIRM_CAPABILITY,
  type DiscoveryRepository,
  type DraftItemRow,
  type DraftReviewRepository,
} from '@healer/domain-architecture';
import { scope } from '@healer/shared';
import { refuseUnverifiedGraphReview, resolveTenant } from './discovery-http.js';
import { DISCOVERY_REPOSITORY } from './discovery-runs.controller.js';

export const DRAFT_REVIEW_REPOSITORY = Symbol('DRAFT_REVIEW_REPOSITORY');

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
  async confirm(@Param('draftId') draftId: string, @Body() body: unknown): Promise<unknown> {
    void GRAPH_CONFIRM_CAPABILITY; // this route is what that capability gates (FR-010, R-09)
    void draftId;
    void body;
    // Fail closed: no caller can yet be verified as a human, and no header is trusted to say
    // otherwise (see refuseUnverifiedGraphReview). Nothing is parsed or looked up.
    refuseUnverifiedGraphReview('confirmDraftItems');
  }

  /** `GRAPH_CONFIRM_CAPABILITY`-gated route (FR-010, R-09) — rejection is decided by the same
   *  human-actor gate as confirmation, see this class's own doc comment. */
  @Post(':draftId/reject')
  @HttpCode(200)
  async reject(@Param('draftId') draftId: string, @Body() body: unknown): Promise<unknown> {
    void GRAPH_CONFIRM_CAPABILITY; // this route is what that capability gates (FR-010, R-09)
    void draftId;
    void body;
    // Fail closed: no caller can yet be verified as a human, and no header is trusted to say
    // otherwise (see refuseUnverifiedGraphReview). Nothing is parsed or looked up.
    refuseUnverifiedGraphReview('rejectDraftItems');
  }
}
