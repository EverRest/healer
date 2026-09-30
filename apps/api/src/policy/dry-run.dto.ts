import { decisionInputSchema, type DecisionInput } from '@healer/domain-policy';

/**
 * `POST /policy/dry-run` body: the domain's own closed `decisionInputSchema` (T006/T007) *is*
 * the wire contract here (batch-7 brief: "dispatches ExplainDecision with the request body as the
 * DecisionInput") — reused rather than re-declared, so there is exactly one authority for "no
 * confidence field exists" (R-03) and this endpoint proves the same rejection T007 already proved
 * in-process now happens over HTTP too.
 *
 * One adaptation only: JSON has no `Date` type, so `evaluatedAt` arrives as an ISO string and is
 * parsed before `decisionInputSchema.strict()` ever sees it — the schema itself is untouched.
 */
export function parseDryRunRequest(
  body: unknown,
): ReturnType<typeof decisionInputSchema.safeParse> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return decisionInputSchema.safeParse(body);
  }
  const withDate: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (typeof withDate.evaluatedAt === 'string') {
    const parsed = new Date(withDate.evaluatedAt);
    if (!Number.isNaN(parsed.getTime())) withDate.evaluatedAt = parsed;
  }
  return decisionInputSchema.safeParse(withDate);
}

export type { DecisionInput };
