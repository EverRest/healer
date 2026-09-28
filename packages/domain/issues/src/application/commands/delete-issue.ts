import { scope, type TenantContext } from '@healer/shared';
import {
  checkDeletionRequest,
  type DeleteIssueResult,
  type IssueDeletionRepository,
} from '../../domain/deletion.js';

/**
 * `DeleteIssue` (001 T053, FR-018). Thin on purpose, same reasoning as `MergeIssues`: the guarantees
 * — one transaction for every delete, the tombstone and the outbox row; one tombstone per issue —
 * hold in `IssueDeletionRepository`'s implementation and the database. This scopes the call to the
 * tenant and refuses a request with no requester or no reason before anything is locked.
 *
 * `requestedBy` is a caller-asserted actor string (the same trust level as the `X-Actor-Id` a close
 * takes), not an authenticated identity: the auth layer carries a tenant id only.
 */
export async function deleteIssue(
  repo: IssueDeletionRepository,
  context: TenantContext,
  input: { readonly id: string; readonly requestedBy: string; readonly reason: string },
): Promise<DeleteIssueResult> {
  checkDeletionRequest(input.requestedBy, input.reason);
  return repo.deleteIssue(scope(context, { id: input.id }), input.requestedBy, input.reason);
}
