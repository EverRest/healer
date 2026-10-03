// The closed reason-code set (003 T012, R-07, contracts/collection-plan.md). Its one authority is
// the boundary contract — the runner emits these codes and the control plane branches on them, so
// neither side may hold a copy. Re-exported here because the domain reads them by this name.
export { GAP_REASON_CODES, type GapReasonCode } from '@healer/boundary-contract';
