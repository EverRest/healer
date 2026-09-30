import {
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
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DuplicateRuleKeyError,
  publishRuleset,
  RulesetPredicateInvalidError,
  StaleRulesetVersionError,
  type PolicyRulesetRepository,
  type PublishedRuleset,
} from '@healer/domain-policy';
import { newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { publishRulesetRequestSchema } from './publish-ruleset.dto.js';
import { requireIdempotencyKey, resolveActor, resolveTenant } from './policy-http.js';

export const POLICY_RULESET_REPOSITORY = Symbol('POLICY_RULESET_REPOSITORY');

function serializeRuleset(ruleset: PublishedRuleset) {
  return {
    id: ruleset.id,
    version: ruleset.version,
    digest: ruleset.digest,
    publishedAt: ruleset.publishedAt,
    publishedBy: ruleset.publishedBy,
    supersedesVersion: ruleset.supersedesVersion ?? null,
    conflictWarnings: ruleset.conflictWarnings,
    rules: ruleset.rules,
  };
}

/**
 * `GET /policy/rulesets`, `POST /policy/rulesets`, `GET /policy/rulesets/{version}` (T027,
 * FR-004, FR-020, SC-003, quickstart 33). `POST` dispatches the already-built `publishRuleset`
 * command; both `GET`s are thin reads over `PolicyRulesetRepository`. `{version}` resolves a
 * superseded version exactly as it resolves the latest one — nothing here treats "current" as
 * special, which is what makes SC-003 ("a version cited by a decision resolves forever") hold.
 */
@Controller('policy/rulesets')
export class PolicyRulesetsController {
  constructor(
    @Inject(POLICY_RULESET_REPOSITORY) private readonly rulesets: PolicyRulesetRepository,
  ) {}

  @Get()
  async list(
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ items: readonly unknown[] }> {
    const context = resolveTenant(tenantIdHeader);
    const items = await this.rulesets.list(scope(context, {}));
    return { items: items.map(serializeRuleset) };
  }

  @Post()
  @HttpCode(201)
  async publish(
    @Body() body: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('x-actor-id') actorIdHeader?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    requireIdempotencyKey(idempotencyKey);
    const actor = resolveActor(actorIdHeader);

    const parsed = publishRulesetRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `invalid rule set: ${parsed.error.issues[0]?.message ?? 'malformed request'}`,
      );
    }

    try {
      const published = await withCorrelation(newCorrelationId(), () =>
        publishRuleset(this.rulesets, context, { rules: parsed.data.rules, publishedBy: actor }),
      );
      return serializeRuleset(published);
    } catch (error) {
      if (error instanceof DuplicateRuleKeyError || error instanceof RulesetPredicateInvalidError) {
        throw new UnprocessableEntityException(error.message);
      }
      if (error instanceof StaleRulesetVersionError) {
        // Every retry available to `publishRuleset` itself was already exhausted against real
        // concurrent traffic — a caller-facing 409 (not 422: the request was valid, the timing
        // wasn't) is the honest report, same posture as `DECISION_ALREADY_CONSUMED`.
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get(':version')
  async getOne(
    @Param('version') versionParam: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    const version = Number(versionParam);
    if (!Number.isInteger(version)) {
      throw new NotFoundException(`"${versionParam}" is not a valid rule set version`);
    }
    const ruleset = await this.rulesets.findByVersion(scope(context, { version }));
    if (ruleset === null) {
      throw new NotFoundException(`rule set version ${version} not found`);
    }
    return serializeRuleset(ruleset);
  }
}
