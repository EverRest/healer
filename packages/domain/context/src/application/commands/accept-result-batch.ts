import { createHash, randomUUID } from 'node:crypto';
import {
  COLLECTION_CONTRACT_VERSION,
  validateResultBatchIngress,
  type CollectionResultBatch,
} from '@healer/boundary-contract';
import { scope, type TenantContext } from '@healer/shared';
import {
  BoundarySchemaRejectedError,
  type BoundaryRejectionRepository,
} from '../../domain/boundary-rejection-repository.js';
import { boundaryPayloadRejectedEvent } from '../../domain/events.js';

export interface AcceptResultBatchDeps {
  readonly rejections: BoundaryRejectionRepository;
  readonly now?: () => Date;
}

/** Matches `check:no-payload-at-rest`: a path is structural text, bounded. */
const MAX_PATH_LENGTH = 200;
const INT4_MAX = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function declaredContractVersion(parsed: unknown): number {
  const v = (parsed as { contractVersion?: unknown } | null)?.contractVersion;
  // Bounded to the column: a hostile value must still produce a recorded rejection, not a 500.
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= INT4_MAX
    ? v
    : COLLECTION_CONTRACT_VERSION;
}

/**
 * `QuarantineRejection` folded into the one ingress door (003 T029, FR-010, R-13). The raw body is
 * validated before any domain write; a body that fails — including one that is not JSON — leaves
 * one `boundary_rejection` row and one `BoundaryPayloadRejected` event, written in the same
 * transaction, and then `BoundarySchemaRejectedError`. The payload itself is never stored, logged,
 * evented or put in the error: only the digest of its bytes, its size and value-free paths survive.
 * The caller must be inside a correlated scope (the event needs one).
 */
export async function acceptResultBatch(
  deps: AcceptResultBatchDeps,
  context: TenantContext,
  input: { readonly runnerId: string; readonly rawBody: string; readonly passId?: string },
): Promise<CollectionResultBatch> {
  let parsed: unknown;
  let paths: readonly string[];
  try {
    parsed = JSON.parse(input.rawBody);
    const result = validateResultBatchIngress(parsed);
    if (result.ok && result.batch !== undefined) return result.batch;
    paths = result.schemaErrorPaths ?? [];
  } catch {
    // Deliberately not inspecting the SyntaxError: its message can quote the offending text.
    parsed = undefined;
    paths = ['$#invalid_json'];
  }

  const rejectionId = randomUUID();
  const schemaErrorPaths = paths.map((p) => p.slice(0, MAX_PATH_LENGTH));
  const contractVersion = declaredContractVersion(parsed);
  const bytes = Buffer.from(input.rawBody, 'utf8');

  await deps.rejections.record(
    scope(context, {
      id: rejectionId,
      runnerId: input.runnerId,
      ...(input.passId !== undefined && UUID.test(input.passId) ? { passId: input.passId } : {}),
      contractVersion,
      schemaErrorPaths,
      payloadDigest: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.length,
      receivedAt: (deps.now ?? (() => new Date()))(),
    }),
    boundaryPayloadRejectedEvent(context.tenantId, {
      rejectionId,
      runnerId: input.runnerId,
      contractVersion,
      schemaErrorPaths,
    }),
  );
  throw new BoundarySchemaRejectedError(rejectionId, schemaErrorPaths);
}
