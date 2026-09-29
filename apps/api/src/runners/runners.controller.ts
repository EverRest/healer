import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import {
  resolveHandshake,
  type CapabilityRequirement,
  type HandshakeStatus,
} from '@healer/boundary-contract';
import {
  NotFoundError,
  TenantContext,
  TenantIsolationError,
  newCorrelationId,
  scope,
  withCorrelation,
} from '@healer/shared';
import { runnerHeartbeatRequestSchema } from './runner-heartbeat.dto.js';
import type { RunnerRegistrationRepository } from './domain/repository.js';

export const RUNNER_REGISTRATION_REPOSITORY = Symbol('RUNNER_REGISTRATION_REPOSITORY');

/**
 * No consumer declares a required capability yet — no directive dispatcher (T051, deferred), no
 * collection-plan reader. Resolving against an empty requirement set means today's status is
 * driven only by protocol-version compatibility (FR-018's own headline scenario), which is
 * exactly what T039/T044's handshake matrix already covers. The first real consumer (e.g. T093's
 * `inference` capability) is what defines a real, non-empty list — not invented here ahead of it
 * (QUESTIONS.md "012 phase 6, T042").
 */
const NO_CAPABILITY_REQUIREMENTS: readonly CapabilityRequirement[] = [];

export interface RunnerHeartbeatResponse {
  readonly status: HandshakeStatus;
  readonly resolvedCapabilities: readonly string[];
  readonly refusedReason?: string;
  /** Always empty — a directive producer is T051's territory, out of scope here (QUESTIONS.md). */
  readonly directives: readonly never[];
}

/**
 * `POST /runners/heartbeat` (012 T042, FR-018, FR-020): the runner's one outbound call, used both
 * to register and on every later heartbeat. Thin by rule (`.claude/rules/backend-nestjs.md`):
 * validate, resolve the handshake via the already-built pure `resolveHandshake`
 * (`@healer/boundary-contract`), and upsert — no handshake logic reimplemented here.
 */
@Controller('runners')
export class RunnersController {
  constructor(
    @Inject(RUNNER_REGISTRATION_REPOSITORY)
    private readonly runners: RunnerRegistrationRepository,
  ) {}

  // Same deliberate, TODO-flagged stub-auth pattern as every other controller in this app (001
  // T019) — no credential is verified yet.
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

  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(
    @Body() body: unknown,
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<RunnerHeartbeatResponse> {
    return withCorrelation(newCorrelationId(), async () => {
      const context = this.resolveTenant(tenantIdHeader);

      const parsed = runnerHeartbeatRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new BadRequestException(parsed.error.flatten());
      }
      const request = parsed.data;

      // Heartbeat-only fields (FR-020): validated by the schema above, accepted, and — per the
      // recorded decision — not persisted or otherwise consumed yet (QUESTIONS.md). Read here so
      // the intent is visible at the call site, not silently dropped by the schema alone.
      void request.resourceState;
      void request.clockOffsetMs;
      void request.lastSuccessfulTask;

      const result = resolveHandshake(
        {
          protocolVersion: request.protocolVersion,
          imageVersion: request.imageVersion,
          capabilities: request.capabilities,
          resourceLimits: request.resourceLimits,
        },
        NO_CAPABILITY_REQUIREMENTS,
      );

      try {
        await this.runners.upsert(
          scope(context, {
            name: request.name,
            protocolVersion: request.protocolVersion,
            capabilities: request.capabilities,
            imageVersion: request.imageVersion,
            status: result.status,
            lastHeartbeatAt: new Date(),
            ...(result.refusedReason !== undefined ? { refusedReason: result.refusedReason } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new NotFoundException(error.message);
        }
        throw error;
      }

      return {
        status: result.status,
        // The intersection with an empty requirement set is the runner's own declared set, not
        // the empty set (review finding): `resolveHandshake`'s own `resolvedCapabilities` is
        // computed from per-requirement resolutions, so it is always `[]` while nothing is
        // required — `runner-protocol.md`'s own words are "the resolved capability set — the
        // intersection", and a runner that declared a capability nothing yet requires must not be
        // told it has zero usable capabilities. Once `NO_CAPABILITY_REQUIREMENTS` gains a real,
        // non-empty entry, `resolveHandshake`'s own computed set becomes the correct one to use
        // instead — this fallback exists only because that list is empty today.
        resolvedCapabilities:
          NO_CAPABILITY_REQUIREMENTS.length === 0 && result.status !== 'refused'
            ? request.capabilities
            : result.resolvedCapabilities,
        ...(result.refusedReason !== undefined ? { refusedReason: result.refusedReason } : {}),
        directives: [],
      };
    });
  }
}
