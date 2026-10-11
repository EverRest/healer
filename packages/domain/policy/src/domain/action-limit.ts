import { HealerError, type TenantScoped } from '@healer/shared';
import type { ActionClass } from './action-class.js';
import type { DecisionInput } from './decision-input.js';
import type { StepKey } from './request-key.js';
import type { CooldownBounds } from './rule.js';

// FR-014 (T054, T055, T085): rate limit, cooldown and attempt cap per `(actionKey, targetRef,
// fingerprint)`. `policy.action_limit` is the ONLY store of these bounds (C-11); the counts are
// derived from `policy_decision` history, never kept. Both are resolved by the binder and baked
// into `DecisionInput.cooldown` (C-82), so a replay needs neither table.

export type CooldownGroup = DecisionInput['cooldown'];

/** Minimum values `policy.action_limit` accepts — literals in migration 20261009000000 as CHECK
 *  constraints too; `action-limit.test.ts` fails if the two disagree. A zero rate or cap would be a
 *  limit nobody can satisfy, which is a DENY-everything switch spelled as a limit. */
export const ACTION_LIMIT_MINIMA = {
  ratePerWindow: 1,
  windowSeconds: 1,
  cooldownSeconds: 0,
  attemptCap: 1,
} as const;

/** The action class whose repeats the product bounds when a tenant configured nothing. */
export const DEFAULT_LIMITED_CLASS: ActionClass = 'reversible_remediation';

/**
 * PLACEHOLDER (stage-0): the bounds a `reversible_remediation` action runs under when its tenant
 * has no `policy.action_limit` row, so an unconfigured tenant is bounded, never unbounded
 * (fail closed, FR-014). Authority for changing them: QUESTIONS.md "002 Phase 5 (T054, T055,
 * T085) — judgment calls (rate limits)"; nothing yet grounds any value in measurement.
 *  - ratePerWindow 1 / windowSeconds 3600: one remediation of a given target per hour — a repeat
 *    inside the hour is a sign the first one did not hold, which is a human's call.
 *  - cooldownSeconds 3600: equal to the window, so the cooldown and the rate limit agree until a
 *    tenant tunes them apart.
 *  - attemptCap 3: after three allowed remediations of the same target and fingerprint, ever,
 *    stop and route to a person.
 * Other classes get no default: an all-time cap on, say, investigation steps would break the
 * product. They are bounded only by a configured row.
 */
export const DEFAULT_REMEDIATION_ACTION_LIMIT = {
  ratePerWindow: 1,
  windowSeconds: 3600,
  cooldownSeconds: 3600,
  attemptCap: 3,
} as const;

/** The advisory-lock key serialising counts-then-insert for one scope. Exported so a test can hold
 *  the lock open and prove a concurrent evaluation waits behind it. */
export function actionLimitLockKey(
  tenantId: string,
  actionKey: string,
  targetRef: string | null | undefined,
  fingerprint: string | null | undefined,
): string {
  return `policy.action_limit:${tenantId}:${actionKey}:${targetRef ?? ''}:${fingerprint ?? ''}`;
}

/** The scope one evaluation's limit applies to, plus the instant the window ends at. */
export interface ActionLimitQuery {
  readonly actionKey: string;
  readonly actionClass: ActionClass;
  readonly targetRef?: string;
  readonly fingerprint?: string;
  readonly asOf: Date;
  /** The step being evaluated, when it is bound to a run and a state: its own earlier live allow is
   *  left out of the counts, so a retry neither counts nor refuses itself while every other attempt
   *  still counts. */
  readonly step?: StepKey;
}

export function actionLimitQueryOf(input: DecisionInput): ActionLimitQuery {
  return {
    actionKey: input.action.actionKey,
    actionClass: input.action.actionClass,
    targetRef: input.target.targetRef,
    fingerprint: input.target.fingerprint,
    asOf: input.evaluatedAt,
  };
}

/** A decision could not take the scope's limit lock inside its bounded wait. Retryable (429),
 *  same as `BudgetContentionError`. */
export class ActionLimitContentionError extends HealerError {
  constructor() {
    super('RATE_LIMITED', 'this action and target are busy; retry the evaluation');
    this.name = 'ActionLimitContentionError';
  }
}

/** What the single SQL read returns: the configured row (if any) and the three aggregates. */
export interface ActionLimitRead {
  readonly configured: CooldownBounds | null;
  readonly windowSeconds: number;
  readonly recentAllowCount: number;
  readonly attemptCount: number;
  readonly secondsSinceLastAllow: number | null;
}

/** Pure: the bounds that apply (the row, else the class default, else none) and the resulting
 *  `DecisionInput.cooldown` group. */
export function cooldownGroupOf(read: ActionLimitRead, actionClass: ActionClass): CooldownGroup {
  const { windowSeconds: _unused, ...defaults } = DEFAULT_REMEDIATION_ACTION_LIMIT;
  const bounds =
    read.configured ?? (actionClass === DEFAULT_LIMITED_CLASS ? { ...defaults } : undefined);
  return {
    recentAllowCount: read.recentAllowCount,
    windowSeconds: read.windowSeconds,
    attemptCount: read.attemptCount,
    ...(read.secondsSinceLastAllow !== null
      ? { secondsSinceLastAllow: read.secondsSinceLastAllow }
      : {}),
    ...(bounds !== undefined ? { bounds } : {}),
  };
}

export interface ReadOnlyActionLimitRepository {
  /** Unlocked: a dry run, or any caller that does not persist. The persisting callers resolve under
   *  the scope's lock inside `recordLimited` / `bindCharged` instead. */
  resolve(where: TenantScoped<ActionLimitQuery>): Promise<CooldownGroup>;
}
