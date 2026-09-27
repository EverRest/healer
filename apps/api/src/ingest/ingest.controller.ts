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
  ingestSignalBatch,
  SignalQueueUnavailableError,
  type ErrorSignature,
  type IngestionDeliveryRepository,
  type Signal,
  type SignalQueue,
} from '@healer/domain-issues';
import {
  newCorrelationId,
  TenantContext,
  TenantIsolationError,
  withCorrelation,
} from '@healer/shared';
import {
  ingestSignalsRequestSchema,
  parseSignalBatch,
  type RejectedSignal,
  type SignalDto,
} from './ingest-signals.dto.js';

/**
 * zod's `.optional()` types a field as `T | undefined`, which `exactOptionalPropertyTypes`
 * treats as distinct from an absent key. `Signal`'s and `ErrorSignature`'s optional fields must
 * be absent, not present-with-undefined, so this drops rather than assigns.
 */
function toErrorSignature(dto: SignalDto['errorSignature']): ErrorSignature {
  return {
    ...(dto.exceptionType !== undefined && { exceptionType: dto.exceptionType }),
    ...(dto.frames !== undefined && { frames: dto.frames }),
    ...(dto.endpointTemplate !== undefined && { endpointTemplate: dto.endpointTemplate }),
    ...(dto.errorCode !== undefined && { errorCode: dto.errorCode }),
  };
}

function toSignal(dto: SignalDto): Signal {
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
 * DI tokens (see `HEALTH_META` for why a token, not a bare type).
 */
export const SIGNAL_QUEUE = Symbol('SIGNAL_QUEUE');
export const INGESTION_DELIVERY_REPOSITORY = Symbol('INGESTION_DELIVERY_REPOSITORY');

/**
 * `POST /ingest/signals` (001 T019/T020/T021, FR-004, FR-019): validate, deduplicate by
 * `(tenant, provider, X-Delivery-Id)`, and enqueue — never process inline. A slow or failing
 * signal must never block a provider — this controller never calls `ingestSignal` itself and
 * never awaits anything past the enqueue.
 */
@Controller()
export class IngestController {
  constructor(
    @Inject(SIGNAL_QUEUE) private readonly queue: SignalQueue,
    @Inject(INGESTION_DELIVERY_REPOSITORY) private readonly deliveries: IngestionDeliveryRepository,
  ) {}

  @Post('ingest/signals')
  @HttpCode(202)
  async ingest(
    @Body() body: unknown,
    // TODO(001 T019, security): no `ingestBearer` credential is verified yet — this header is
    // read as-is. A bare, unverified header is a more honest stub of "no auth exists" than
    // pretending to parse a bearer token would be; `forTrustedInternalUse` below makes the gap
    // greppable. Must be replaced before this endpoint is reachable from outside a trusted network.
    @Headers('x-tenant-id') tenantIdHeader?: string,
    // Required by the contract (`contracts/openapi.yaml`); a repeat is acknowledged and dropped.
    @Headers('x-delivery-id') deliveryIdHeader?: string,
    // TODO(001 T020, security): same stub-auth gap as X-Tenant-Id above — `ingestBearer` would
    // carry provider identity for real; until then a bare header stands in for it, kept
    // deliberately as honest and greppable as the tenant stub next to it.
    @Headers('x-provider-id') providerIdHeader?: string,
  ): Promise<{ accepted: number; duplicate: boolean; rejected?: readonly RejectedSignal[] }> {
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

      if (!deliveryIdHeader) {
        throw new BadRequestException('X-Delivery-Id header is required');
      }
      if (!providerIdHeader) {
        throw new BadRequestException('X-Provider-Id header is required');
      }

      // Per-signal, not `z.array(signalSchema)` (001 T024, quickstart 20): one malformed
      // signal must not reject its batch-mates. `rejected` names each one and why — FR-019's
      // "nothing dropped silently" met by telling the caller, not by inventing an evidence
      // record with no issue to attach to (see QUESTIONS.md).
      const { valid, rejected } = parseSignalBatch(parsed.data.signals);
      const signals: Signal[] = valid.map(toSignal);

      try {
        const result = await ingestSignalBatch(
          this.queue,
          this.deliveries,
          context,
          { provider: providerIdHeader, deliveryId: deliveryIdHeader },
          signals,
        );
        return rejected.length > 0 ? { ...result, rejected } : result;
      } catch (error) {
        // FR-019 "never blocks the provider": a queue that cannot be reached within budget
        // must fail loudly and fast, not hang and not surface as an opaque 500 — 503 tells the
        // provider this is transient and retriable.
        if (error instanceof SignalQueueUnavailableError) {
          throw new ServiceUnavailableException('signal queue is temporarily unavailable');
        }
        throw error;
      }
    });
  }
}
