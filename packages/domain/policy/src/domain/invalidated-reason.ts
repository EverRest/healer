// `policy_decision.invalidated_reason` (data-model.md): why a decision stopped being usable. A
// closed list with **this file as its one authority** — `data-model.md` and `contracts/openapi.yaml`
// restate it for readers and `invalidated-reason.test.ts` fails if either drifts. The column is
// plain text in the database (a CHECK would make adding a reason a migration), so this list is what
// stops a writer inventing one.
export const INVALIDATED_REASONS = [
  'epoch_bump',
  'approval_expired',
  'approval_rejected',
  // 002 T060: an allowed AI step whose run never landed, released by `releaseAbandonedCharges` so
  // its open charge stops counting against the budget.
  'charge_abandoned',
] as const;

export type InvalidatedReason = (typeof INVALIDATED_REASONS)[number];
