// Mirrors prisma/schema.prisma's `policy.policy_reason_code` enum (data-model.md `policy_rule`).
// Closed set: adding one is a spec change, so a decision can never carry a reason nobody
// planned for. Same mirroring convention as `action-class.ts` / `packages/domain/evidence`.
export const REASON_CODES = [
  'NO_MATCHING_RULE',
  'CEILING_EXCEEDED',
  'NO_AUTONOMY_GRANT',
  'GRANT_REVOKED',
  'ENVIRONMENT_RESTRICTED',
  'COMPONENT_RESTRICTED',
  'ISSUE_KIND_RESTRICTED',
  'IMPACT_CLASS_RESTRICTED',
  'EVIDENCE_INCOMPLETE',
  'NO_ADOPTED_EXPECTATION',
  'UNDO_NOT_ATTESTED',
  'BUDGET_EXHAUSTED',
  'RATE_LIMITED',
  'COOLDOWN',
  'ATTEMPT_CAP_REACHED',
  'ESCALATION_CAP_REACHED',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'TARGET_BLOCKED',
  'CATEGORY_NOT_ALLOWLISTED',
  'TOPIC_BLOCKED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];
