import {
  BadRequestException,
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
  OUTCOME_ORDER,
  replayDecision,
  type Decision,
  type Outcome,
  type PolicyDecisionRepository,
  type PolicyRulesetRepository,
  type StoredDecision,
} from '@healer/domain-policy';
import { scope } from '@healer/shared';
import { resolveTenant, UUID_PATTERN } from './policy-http.js';
import { POLICY_RULESET_REPOSITORY } from './policy-rulesets.controller.js';

const OUTCOMES: ReadonlySet<string> = new Set(OUTCOME_ORDER);

export const POLICY_DECISION_REPOSITORY = Symbol('POLICY_DECISION_REPOSITORY');

function serializeDecision(decision: StoredDecision) {
  return {
    id: decision.id,
    actionKey: decision.actionKey,
    issueId: decision.issueId ?? null,
    workflowRunId: decision.workflowRunId ?? null,
    workflowState: decision.workflowState ?? null,
    targetRef: decision.targetRef ?? null,
    fingerprint: decision.fingerprint ?? null,
    proposalDigest: decision.proposalDigest,
    decisionInput: decision.decisionInput,
    rulesetVersion: decision.rulesetVersion,
    matchedRuleKeys: decision.matchedRuleKeys,
    outcome: decision.outcome,
    reasonCodes: decision.reasonCodes,
    ceilingApplied: decision.ceilingApplied,
    budgetState: decision.budgetState,
    evaluatedAt: decision.evaluatedAt,
    consumedAt: decision.consumedAt ?? null,
    invalidatedReason: decision.invalidatedReason ?? null,
  };
}

function serializeReplayed(decision: Decision) {
  return {
    outcome: decision.outcome,
    rulesetVersion: decision.rulesetVersion,
    matchedRuleKeys: decision.matchedRuleKeys,
    ceilingApplied: decision.ceilingApplied,
    reasonCodes: decision.reasonCodes,
    evaluatedAt: decision.evaluatedAt,
  };
}

/**
 * `GET /policy/decisions`, `GET /policy/decisions/{decisionId}`, `POST
 * /policy/decisions/{decisionId}/replay` (T028, FR-002, FR-017, quickstart 34). List/get are thin
 * reads over `PolicyDecisionRepository`; replay resolves the decision's own historical rule set
 * (never the tenant's current one, `ReplayDecision`'s own guarantee) and reports the comparison —
 * a differing outcome is `200` with `identical: false`, never a thrown error (contract).
 */
@Controller('policy/decisions')
export class PolicyDecisionsController {
  constructor(
    @Inject(POLICY_DECISION_REPOSITORY) private readonly decisions: PolicyDecisionRepository,
    @Inject(POLICY_RULESET_REPOSITORY) private readonly rulesets: PolicyRulesetRepository,
  ) {}

  @Get()
  async list(
    @Query('issueId') issueId: string | undefined,
    @Query('actionKey') actionKey: string | undefined,
    @Query('outcome') outcome: string | undefined,
    @Query('since') since: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ items: readonly unknown[] }> {
    const context = resolveTenant(tenantIdHeader);

    if (issueId !== undefined && !UUID_PATTERN.test(issueId)) {
      throw new BadRequestException(`"${issueId}" is not a valid issueId`);
    }
    if (outcome !== undefined && !OUTCOMES.has(outcome)) {
      throw new BadRequestException(`"${outcome}" is not a recognized outcome`);
    }
    let sinceDate: Date | undefined;
    if (since !== undefined) {
      sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        throw new BadRequestException(`"${since}" is not a valid date-time`);
      }
    }

    const items = await this.decisions.list(
      scope(context, {
        ...(issueId !== undefined ? { issueId } : {}),
        ...(actionKey !== undefined ? { actionKey } : {}),
        ...(outcome !== undefined ? { outcome: outcome as Outcome } : {}),
        ...(sinceDate !== undefined ? { since: sinceDate } : {}),
      }),
    );
    return { items: items.map(serializeDecision) };
  }

  @Get(':decisionId')
  async getOne(
    @Param('decisionId') decisionId: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    const decision = await this.decisions.findById(scope(context, { id: decisionId }));
    if (decision === null) {
      throw new NotFoundException(`decision ${decisionId} not found`);
    }
    return serializeDecision(decision);
  }

  @Post(':decisionId/replay')
  @HttpCode(200)
  async replay(
    @Param('decisionId') decisionId: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    const decision = await this.decisions.findById(scope(context, { id: decisionId }));
    if (decision === null) {
      throw new NotFoundException(`decision ${decisionId} not found`);
    }

    const { identical, replayed } = await replayDecision({ rulesets: this.rulesets }, context, {
      decisionInput: decision.decisionInput,
      rulesetVersion: decision.rulesetVersion,
      outcome: decision.outcome,
      matchedRuleKeys: decision.matchedRuleKeys,
    });

    return {
      identical,
      original: serializeReplayed(decision),
      replayed: serializeReplayed(replayed),
    };
  }
}
