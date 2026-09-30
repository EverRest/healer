import { decisionInputSchema, type DecisionInput } from '@healer/domain-policy';

/**
 * `POST /policy/dry-run` body: the domain's own closed `decisionInputSchema` (T006/T007) *is*
 * the wire contract here (batch-7 brief: "dispatches ExplainDecision with the request body as the
 * DecisionInput") — reused rather than re-declared, so there is exactly one authority for "no
 * confidence field exists" (R-03) and this endpoint proves the same rejection T007 already proved
 * in-process now happens over HTTP too.
 *
 * No adaptation needed for `evaluatedAt` (removed batch 9 follow-up review): JSON has no `Date`
 * type, so it arrives as a string, but `decisionInputSchema`'s `evaluatedAt` now accepts a proper
 * ISO datetime string directly (`z.string().datetime({ offset: true })`) as well as a `Date` —
 * this used to pre-parse the string with a bare `new Date(...)` before handing it to the schema,
 * which was *looser* than what the schema itself now enforces (a permissive `Date` constructor
 * accepts many non-ISO formats `z.string().datetime()` correctly rejects), so removing it tightens
 * this endpoint's validation rather than weakening it.
 */
export function parseDryRunRequest(
  body: unknown,
): ReturnType<typeof decisionInputSchema.safeParse> {
  return decisionInputSchema.safeParse(body);
}

export type { DecisionInput };
