// Mirrors prisma/schema.prisma's `policy.policy_action_class` enum as a plain string union.
// Domain code cannot import `@prisma/client` (infrastructure-only, 00-core.md), so the closed
// list is declared here too — the same convention `packages/domain/evidence/src/domain/types.ts`
// already established for its own schema's enums.
//
// `merge`, `forward_deploy` and `irreversible` earn no autonomy level in this release (R-05,
// 008 FR-024) — `ceiling.ts` is the single place that turns this list into a level.
export const ACTION_CLASSES = [
  'read_only',
  'code_change',
  'repository_write',
  'reversible_remediation',
  'merge',
  'forward_deploy',
  'irreversible',
] as const;

export type ActionClass = (typeof ACTION_CLASSES)[number];
