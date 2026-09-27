import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  enqueueSignalBatch,
  SignalQueueUnavailableError,
  type ErrorSignature,
  type Signal,
  type SignalQueue,
} from '@healer/domain-issues';
import {
  newCorrelationId,
  TenantContext,
  TenantIsolationError,
  withCorrelation,
} from '@healer/shared';
import { ingestSignalsRequestSchema, type IngestSignalsRequest } from './ingest-signals.dto.js';

/**
 * zod's `.optional()` types a field as `T | undefined`, which `exactOptionalPropertyTypes`
 * treats as distinct from an absent key. `Signal`'s and `ErrorSignature`'s optional fields must
 * be absent, not present-with-undefined, so this drops rather than assigns.
 */
function toErrorSignature(
  dto: IngestSignalsRequest['signals'][number]['errorSignature'],
): ErrorSignature {
  return {
    ...(dto.exceptionType !== undefined && { exceptionType: dto.exceptionType }),
    ...(dto.frames !== undefined && { frames: dto.frames }),
    ...(dto.endpointTemplate !== undefined && { endpointTemplate: dto.endpointTemplate }),
    ...(dto.errorCode !== undefined && { errorCode: dto.errorCode }),
  };
}

function toSignal(dto: IngestSignalsRequest['signals'][number]): Signal {
  return {
    observedAt: new Date(dto.observedAt),
    component: dto.component,
    environment: dto.environment,
    errorSignature: toErrorSignature(dto.errorSignature),
    ...(dto.severity !== undefined && { severity: dto.severity }),
    ...(dto.traceId !== undefined && { traceId: dto.traceId }),
    ...(dto.deploymentRef !== undefined && { deploymentRef: dto.deploymentRef }),
  };
}

/**
 * The DI token for `SignalQueue` (see `HEALTH_META` for why a token, not a bare type).
 */
export const SIGNAL_QUEUE = Symbol('SIGNAL_QUEUE');

/**
 * `POST /ingest/signals` (001 T019, FR-019): validate and enqueue, never process inline. A slow
 * or failing signal must never block a provider — this controller never calls `ingestSignal`
 * itself and never awaits anything past the enqueue.
 */
@Controller()
export class IngestController {
  constructor(@Inject(SIGNAL_QUEUE) private readonly queue: SignalQueue) {}

  @Post('ingest/signals')
  @HttpCode(202)
  async ingest(
    @Body() body: unknown,
    // TODO(001 T019, security): no `ingestBearer` credential is verified yet — this header is
    // read as-is. A bare, unverified header is a more honest stub of "no auth exists" than
    // pretending to parse a bearer token would be; `forTrustedInternalUse` below makes the gap
    // greppable. Must be replaced before this endpoint is reachable from outside a trusted network.
    @Headers('x-tenant-id') tenantIdHeader?: string,
  ): Promise<{ accepted: number; duplicate: boolean }> {
    // One correlation id per request (review finding), not one per signal — every job a batch
    // produces (`BullmqSignalQueue` reads `currentCorrelationId()`) traces back to the delivery
    // that created it, matching every other entry point in this codebase (012 FR-032).
    return withCorrelation(newCorrelationId(), async () => {
      const parsed = ingestSignalsRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new BadRequestException(parsed.error.flatten());
      }

      let context: TenantContext;
      try {
        context = TenantContext.forTrustedInternalUse(tenantIdHeader ?? '');
      } catch (error) {
        if (error instanceof TenantIsolationError) {
          throw new BadRequestException('X-Tenant-Id header is missing or not a valid tenant id');
        }
        throw error;
      }

      const signals: Signal[] = parsed.data.signals.map(toSignal);

      let accepted: number;
      try {
        accepted = await enqueueSignalBatch(this.queue, context, signals);
      } catch (error) {
        // FR-019 "never blocks the provider": a queue that cannot be reached within budget
        // must fail loudly and fast, not hang and not surface as an opaque 500 — 503 tells the
        // provider this is transient and retriable.
        if (error instanceof SignalQueueUnavailableError) {
          throw new ServiceUnavailableException('signal queue is temporarily unavailable');
        }
        throw error;
      }
      // X-Delivery-Id idempotency (001 T020/T021) is not implemented here — every delivery is
      // treated as new.
      return { accepted, duplicate: false };
    });
  }
}
