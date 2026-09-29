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
