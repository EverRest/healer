import { HealerError } from '@healer/shared';

/** T044, R-07: "an approval redeemed with a stale autonomy_epoch is refused" (data-model.md
 *  Invariants). Instantiates the `STALE_AUTONOMY_EPOCH` error code contracts/evaluation.md
 *  reserves for exactly this. */
export class StaleAutonomyEpochError extends HealerError {
  constructor(readonly approvalId: string) {
    super(
      'STALE_AUTONOMY_EPOCH',
      `approval request ${approvalId} was issued under an autonomy epoch that has since changed`,
    );
    this.name = 'StaleAutonomyEpochError';
  }
}

/**
 * The redemption-time check contracts/evaluation.md describes but Phase 7's `ResolveApproval`
 * (T074, out of scope here) has not landed yet to call: an `approval_request` records the
 * tenant's `autonomy_epoch` at issue, and this refuses whenever that recorded value no longer
 * matches the tenant's current one — the same fact whether or not the revocation sweep (T045)
 * ever ran, which is what makes correctness independent of that background job (quickstart 15).
 */
export function checkAutonomyEpoch(
  approval: { readonly id: string; readonly autonomyEpoch: bigint },
  currentEpoch: bigint,
): void {
  if (approval.autonomyEpoch !== currentEpoch) {
    throw new StaleAutonomyEpochError(approval.id);
  }
}
