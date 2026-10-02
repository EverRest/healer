import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ACTION_CEILING,
  explainDecision,
  NoPublishedRulesetError,
  UnregisteredActionError,
  type PolicyActionRepository,
  type PolicyRulesetRepository,
  type ReadOnlyAutonomyGrantRepository,
  type ReadOnlyBudgetRepository,
} from '@healer/domain-policy';
import { AUTONOMY_GRANT_REPOSITORY, BUDGET_REPOSITORY, resolveTenant } from './policy-http.js';
import { parseDryRunRequest } from './dry-run.dto.js';
import { POLICY_RULESET_REPOSITORY } from './policy-rulesets.controller.js';

export const POLICY_ACTION_REPOSITORY = Symbol('POLICY_ACTION_REPOSITORY');

/**
 * `POST /policy/dry-run` and `GET /policy/actions` (T029, FR-019, R-14). Dry-run is *the only
 * evaluation reachable over HTTP* (contracts/evaluation.md) — it dispatches the already-built,
 * read-only `ExplainDecision`, never `EvaluateAndBind`, so nothing this controller does can ever
 * write a `policy_decision` row. Actions is a thin read over the registry, joined with
 * `ACTION_CEILING` (batch 3) — `policy_action` has no `tenant_id` (it is a product fact, not a
 * tenant one), so this is the one policy endpoint that needs no tenant header at all.
 */
@Controller('policy')
export class PolicyEvaluationController {
  constructor(
    @Inject(POLICY_RULESET_REPOSITORY) private readonly rulesets: PolicyRulesetRepository,
    @Inject(POLICY_ACTION_REPOSITORY) private readonly actions: PolicyActionRepository,
    @Inject(AUTONOMY_GRANT_REPOSITORY)
    private readonly autonomyGrants: ReadOnlyAutonomyGrantRepository,
    @Inject(BUDGET_REPOSITORY) private readonly budgets: ReadOnlyBudgetRepository,
  ) {}

  @Post('dry-run')
  @HttpCode(200)
  async dryRun(
    @Body() body: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    const parsed = parseDryRunRequest(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `invalid decision input: ${parsed.error.issues[0]?.message ?? 'malformed request'}`,
      );
    }

    try {
      const { decision, trace } = await explainDecision(
        {
          rulesets: this.rulesets,
          actions: this.actions,
          autonomyGrants: this.autonomyGrants,
          budgets: this.budgets,
        },
        context,
        { decisionInput: parsed.data },
      );
      return {
        outcome: decision.outcome,
        rulesetVersion: decision.rulesetVersion,
        matchedRuleKeys: decision.matchedRuleKeys,
        matchedRules: trace.matchedRules,
        foldResult: trace.foldResult,
        ceilingApplied: trace.ceilingApplied,
        resolvedAutonomyLevel: trace.resolvedAutonomyLevel,
        budgetState: trace.budgetState,
        reasonCodes: trace.reasonCodes,
      };
    } catch (error) {
      if (error instanceof NoPublishedRulesetError || error instanceof UnregisteredActionError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  @Get('actions')
  async list(): Promise<{ items: readonly unknown[] }> {
    const actions = await this.actions.list();
    // `hasTestedUndo` is "derived from 010's catalogue" (contract) — 010 has not landed in this
    // repository, so there is no catalogue to derive it from yet; `false` is the honest current
    // answer for every action, not a placeholder standing in for a real lookup.
    const items = actions.map((action) => {
      const ceiling = ACTION_CEILING(action.actionClass, false);
      return {
        actionKey: action.actionKey,
        actionClass: action.actionClass,
        mutating: action.mutating,
        hasTestedUndo: false,
        ceilingLevel: ceiling.kind === 'level' ? ceiling.level : null,
      };
    });
    return { items };
  }
}
