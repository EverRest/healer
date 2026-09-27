import type { Issue } from './issue.js';

/**
 * The one deterministic correlation rule this feature ships (001 T039, FR-020, quickstart 26): a
 * named rule recorded on the `issue_relationship` row itself, so a `related` link "can be
 * explained and recomputed" (FR-020's own words) — never a model's proposal. Not restricted to a
 * `user_report`+`monitoring_alert` pair: FR-020 names that pairing as the acceptance scenario,
 * not a kind restriction the rule itself enforces — nothing in the requirement exempts two
 * `production_incident`s that happen to share the same symptoms.
 */
export const CORRELATION_RULE = 'component_environment_window';

/**
 * A placeholder, not a measured value — same status as the reopen window (001 T022) and the
 * excerpt size limit (001 T027): `docs/stage-0.md` S0-7 names it. An hour is short relative to
 * the 14-day reopen window on purpose: correlation is "a report and an alert about the same live
 * incident", not "the same failure recurring later".
 */
export const CORRELATION_WINDOW_MS = 60 * 60 * 1000;

/**
 * `componentId` is `null` for every issue today — 004 (architecture-graph) is not built, so
 * nothing resolves a signal's raw component string to a real `Component` yet (001 T018's own
 * documented gap). The `null` guard below means this rule is safe to wire into the live pipeline
 * now, as inert code: two issues both carrying `componentId: null` never "match" by coincidence,
 * so nothing correlates until 004 lands — at which point this needs no change at all.
 */
export function correlates(a: Issue, b: Issue): boolean {
  if (a.componentId === null || b.componentId === null) return false;
  if (a.componentId !== b.componentId) return false;
  if (a.environment !== b.environment) return false;
  return Math.abs(a.firstSeenAt.getTime() - b.firstSeenAt.getTime()) <= CORRELATION_WINDOW_MS;
}
