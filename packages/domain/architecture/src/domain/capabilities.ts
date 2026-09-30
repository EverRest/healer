/**
 * The capability an agent or automation credential must hold to confirm or reject a discovery
 * draft item (004 T015, FR-010, R-09). No credential or capability registry exists anywhere in
 * this codebase yet — 002-policy owns that and has not built it — so nothing checks this today.
 * It is declared here as a literal type, not a plain `string`, so the registry that eventually
 * enforces it, and `scripts/gates/graph-confirm-capability.mjs`'s structural check below, can
 * reference it type-safely: a typo in a future credential's capability list produces a type error
 * instead of a capability that silently matches nothing.
 *
 * "No agent credential carries `graph:confirm`; no MCP tool exposes confirmation" (R-09,
 * graph-contract.md §5) is a fact about the *current* repository, not an enforcement mechanism —
 * `ConfirmDraftItems` (Phase 3, T026) is what will need this constant.
 */
export const GRAPH_CONFIRM_CAPABILITY = 'graph:confirm' as const;
export type GraphConfirmCapability = typeof GRAPH_CONFIRM_CAPABILITY;
