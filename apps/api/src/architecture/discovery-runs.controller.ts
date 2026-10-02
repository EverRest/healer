import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
} from '@nestjs/common';
import type { DiscoveryRepository, DiscoveryRun } from '@healer/domain-architecture';
import {
  HealerError,
  httpStatusFor,
  newCorrelationId,
  scope,
  withCorrelation,
} from '@healer/shared';
import { startDiscoveryRun } from '@healer/domain-architecture';
import { startDiscoveryRunRequestSchema } from './discovery.dto.js';
import { requireIdempotencyKey, resolveTenant } from './discovery-http.js';

export const DISCOVERY_REPOSITORY = Symbol('DISCOVERY_REPOSITORY');

/** `name`/`runnerId` fields nobody has invented a real value for yet (no runner dispatch exists —
 *  see this file's own doc comment) — the same "stub header, undocumented gap" shape T042's own
 *  `name` field and T045's `DirectiveEnvelope` both already are (QUESTIONS.md "012 phase 6"). */
const UNASSIGNED_RUNNER_ID = 'control-plane';

function serializeRun(run: DiscoveryRun, trigger: string, sources: readonly string[] | undefined) {
  return {
    runId: run.id,
    baseVersion: run.baseVersion,
    trigger,
    sources: sources ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/**
 * `POST /discovery/runs`, `GET /discovery/runs` (T033, FR-009, FR-022, FR-023).
 *
 * **Scope note, not silently assumed**: `POST` here only creates the `discovery_run` row via the
 * already-built `startDiscoveryRun` (pins `base_version`, FR-009) and returns `202` — real
 * collection (`collectDiscovery`/`ingestDiscoveryBatch`, T018-T021) runs against adapters that
 * need live, execution-plane credentials (graph-contract.md §3: discovery collectors run in the
 * execution plane). No dispatch-to-runner mechanism exists yet (the same gap T045/T051's own
 * "directives have no producer" note already names for 012) — building one here would invent
 * machinery this batch was not asked for and no later consumer exists to drive. Flagged in
 * QUESTIONS.md, not silently left unbuilt.
 */
@Controller('discovery/runs')
export class DiscoveryRunsController {
  constructor(@Inject(DISCOVERY_REPOSITORY) private readonly discovery: DiscoveryRepository) {}

  @Post()
  @HttpCode(202)
  async start(
    @Body() body: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    const context = resolveTenant(tenantIdHeader);
    requireIdempotencyKey(idempotencyKey);

    const parsed = startDiscoveryRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { code: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'invalid request' },
        httpStatusFor('VALIDATION'),
      );
    }

    try {
      const run = await withCorrelation(newCorrelationId(), () =>
        startDiscoveryRun(this.discovery, context, {
          trigger: parsed.data.trigger,
          runnerId: parsed.data.runnerId ?? UNASSIGNED_RUNNER_ID,
        }),
      );
      return serializeRun(run, parsed.data.trigger, parsed.data.sources);
    } catch (error) {
      if (error instanceof HealerError) {
        throw new HttpException(error.toBody(), httpStatusFor(error.code));
      }
      throw error;
    }
  }

  @Get()
  async list(
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ items: readonly unknown[] }> {
    const context = resolveTenant(tenantIdHeader);
    const runs = await this.discovery.listRuns(scope(context, {}));
    return {
      items: runs.map((run) => ({
        runId: run.id,
        trigger: run.trigger,
        runnerId: run.runnerId,
        baseVersion: run.baseVersion,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        outcome: run.outcome,
        sourceOutcomes: run.sourceOutcomes,
      })),
    };
  }
}
