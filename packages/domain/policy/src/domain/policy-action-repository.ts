import type { ActionClass } from './action-class.js';

/**
 * `policy.policy_action` (data-model.md, T014) — the action registry. The typed in-process
 * evaluation surface (`evaluate`/`EvaluateAndBind`/`ExplainDecision`) is meant to be the only way
 * to obtain an `ALLOW` (FR-001, R-14); this is the registry itself, not that enforcement, which
 * has no caller yet (`EvaluateAndBind` lands in phase 3).
 *
 * Reversibility is deliberately absent here — it is derived from 010's catalogue (R-06), never
 * stored on the registry row.
 */
export interface PolicyAction {
  readonly actionKey: string;
  readonly actionClass: ActionClass;
  readonly mutating: boolean;
  readonly owningSpec: string;
  readonly introducedAt: Date;
}

/**
 * The two action keys this spec's own tests/quickstart reference (quickstart 7, 10, 39; research
 * R-05's ceiling table). 008 and 010 are not implemented in this repository yet, so this is not
 * 010's full remediation catalogue — only what 002 itself needs to evaluate against. Importing
 * this constant (rather than restating the two rows at each call site) is what keeps the registry
 * a closed list with one authority (AGENTS.md) once a real caller and 010's catalogue both exist.
 */
export const SEED_POLICY_ACTIONS: readonly Omit<PolicyAction, 'introducedAt'>[] = [
  {
    actionKey: 'change.open_pull_request',
    actionClass: 'code_change',
    mutating: true,
    owningSpec: '008',
  },
  {
    actionKey: 'deployment.rollback',
    actionClass: 'reversible_remediation',
    mutating: true,
    owningSpec: '010',
  },
  // `PublishRuleset` audits as `policy.publish_ruleset` (`publish-ruleset.ts`'s
  // `PUBLISH_RULESET_AUDIT_ACTION`) — batch 9 I1, review finding: unregistered, this tripped
  // batch 8's own `check:policy-coverage` LEFT-join fix on every ruleset publish, including this
  // spec's own (a check that is red from day one has no reader). `mutating: false` because this
  // action is not gated by `evaluate()` at all — a publish is an admin/config change, not a
  // decision the ceiling applies to, so it never needs a consumed ALLOW behind it.
  // `actionClass` has no clean fit in `ACTION_CLASSES` (none of the seven describe "an admin
  // action over the policy engine itself"); `read_only` is the least wrong of them — it changes
  // nothing about how the action is treated, since `mutating: false` already means no ceiling
  // ever applies to it.
  {
    actionKey: 'policy.publish_ruleset',
    actionClass: 'read_only',
    mutating: false,
    owningSpec: '002',
  },
  // Registered up front (T039), applying batch 9 I1's own fix before `check:policy-coverage`
  // would otherwise have to find the gap: grant/revoke are admin/config changes, never a decision
  // the ceiling itself gates, so `mutating: false` exactly as `policy.publish_ruleset` above.
  {
    actionKey: 'policy.grant_autonomy',
    actionClass: 'read_only',
    mutating: false,
    owningSpec: '002',
  },
  {
    actionKey: 'policy.revoke_autonomy',
    actionClass: 'read_only',
    mutating: false,
    owningSpec: '002',
  },
  {
    actionKey: 'policy.request_approval',
    actionClass: 'read_only',
    mutating: false,
    owningSpec: '002',
  },
  {
    actionKey: 'policy.resolve_approval',
    actionClass: 'read_only',
    mutating: false,
    owningSpec: '002',
  },
  {
    actionKey: 'policy.expire_approval',
    actionClass: 'read_only',
    mutating: false,
    owningSpec: '002',
  },
  {
    actionKey: 'policy.revoke_approval',
    actionClass: 'read_only',
    mutating: false,
    owningSpec: '002',
  },
];

/**
 * `policy_action` is global, not tenant-scoped (data-model.md: "the set of actions the product
 * can perform is a product fact") — the one repository in this batch that does **not** take a
 * `TenantContext` (T015's pattern applies to every other repository method touched here).
 */
export interface PolicyActionRepository {
  findByKey(actionKey: string): Promise<PolicyAction | null>;
  list(): Promise<readonly PolicyAction[]>;
}
