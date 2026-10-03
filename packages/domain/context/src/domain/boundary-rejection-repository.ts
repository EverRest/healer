import type { DomainEvent } from '@healer/events';
import type { TenantScoped } from '@healer/shared';

/**
 * What a rejected ingress payload leaves behind (R-13): structural paths, a digest and a size.
 * There is no field here that could hold the payload, and that absence is the guarantee — the
 * table has no such column either.
 */
export interface NewBoundaryRejection {
  readonly id: string;
  readonly runnerId: string;
  readonly passId?: string;
  readonly contractVersion: number;
  readonly schemaErrorPaths: readonly string[];
  /** sha256 hex of the raw body bytes. */
  readonly payloadDigest: string;
  readonly byteSize: number;
  readonly receivedAt: Date;
}

export type BoundaryRejection = NewBoundaryRejection & { readonly tenantId: string };

export interface BoundaryRejectionSummary {
  /** Newest first, capped by the repository. */
  readonly items: readonly BoundaryRejection[];
  /** Over the whole filter, not just `items` (FR-010: counts are visible to the tenant). */
  readonly total: number;
  readonly countsByRunner: Readonly<Record<string, number>>;
}

export interface BoundaryRejectionRepository {
  /** The row and the `BoundaryPayloadRejected` outbox event commit together or not at all. */
  record(rejection: TenantScoped<NewBoundaryRejection>, event: DomainEvent): Promise<void>;
  list(
    where: TenantScoped<{ readonly runnerId?: string; readonly since?: Date }>,
  ): Promise<BoundaryRejectionSummary>;
}

/**
 * `BOUNDARY_SCHEMA_REJECTED` (contracts/openapi.yaml). The message and the paths are value-free by
 * construction; `rejectionId` is the only handle on what was recorded.
 */
export class BoundarySchemaRejectedError extends Error {
  readonly code = 'BOUNDARY_SCHEMA_REJECTED' as const;
  readonly httpStatus = 422 as const;

  constructor(
    readonly rejectionId: string,
    readonly schemaErrorPaths: readonly string[],
  ) {
    super('result batch rejected by the boundary schema');
    this.name = 'BoundarySchemaRejectedError';
  }
}
