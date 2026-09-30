import { z } from 'zod';
import {
  fieldKindOf,
  OUTCOME_ORDER,
  REASON_CODES,
  validatePredicateShape,
  type Predicate,
  type PredicateKind,
} from '@healer/domain-policy';

/** `POST /policy/rulesets` body (`contracts/openapi.yaml`): validates the closed predicate
 *  vocabulary at the HTTP boundary — an unknown field, an operator outside that field's domain,
 *  or a value of the wrong type rejects `422 VALIDATION` (contract: "RULESET_INVALID — unknown
 *  predicate field, operator outside the field's domain, or wrong value type"; `@healer/shared`'s
 *  closed `ErrorCode` union has no `RULESET_INVALID` entry, so this maps to the existing
 *  `VALIDATION` code rather than adding a new one to that single-authority list — a call worth
 *  flagging, not a silent substitution).
 *
 * `fieldKindOf` and `validatePredicateShape` (`@healer/domain-policy`) are the single runtime
 * authority for the predicate vocabulary, including every value-shape check (batch 9 follow-up
 * review, round 3: this file used to hand-copy a second, `.strict()` value-schema table —
 * `VALUE_SCHEMA_BY_KIND_AND_OPERATOR` — that had already drifted from the domain's own
 * `validateQuantityValue`, accepting/rejecting different things for the same input, and whose
 * generic zod error ran *before* `validatePredicateShape` ever got a chance to report its more
 * precise message over HTTP). This file now does exactly two things a caller who never went
 * through `tsc` needs help with: deriving `kind` from `field` (JSON has no discriminated unions,
 * so a raw wire object `{field, operator, value}` has no `kind` tag to read `fieldKindOf` to
 * start `validatePredicateShape` at all) and the quantity numeric-shorthand sugar
 * (`quantityValue()`: a bare number means `{kind: 'literal', value: number}`). Everything else —
 * the operator-domain check, every value-shape check, same-quantity-group, unparseable instant
 * literals — is `validatePredicateShape` alone, called once, so the HTTP edge and an in-process
 * caller reject the same malformed predicates for the same reason with the same message.
 */
type Kind = PredicateKind;

const rawPredicateSchema = z
  .object({ field: z.string(), operator: z.string(), value: z.unknown().optional() })
  .strict();

function quantityValue(kind: Kind, raw: unknown): unknown {
  if (kind !== 'quantity') return raw;
  if (typeof raw === 'number') return { kind: 'literal', value: raw };
  return raw;
}

/** One predicate `{field, operator, value}` → the domain's tagged `Predicate`, or an issue on
 *  `ctx` (never a thrown error — that would surface as a 500, not the 422 this exists to
 *  produce). */
function validatePredicate(
  raw: { readonly field: string; readonly operator: string; readonly value?: unknown },
  ctx: z.RefinementCtx,
): Predicate | typeof z.NEVER {
  const kind = fieldKindOf(raw.field);
  if (kind === undefined) {
    ctx.addIssue({ code: 'custom', message: `unknown predicate field "${raw.field}"` });
    return z.NEVER;
  }

  // Boolean predicates carry no `value` in the domain shape (`predicates/types.ts`) — whatever
  // the caller sent for it is passed through and `validatePredicateShape` drops it below.
  const predicate = (
    kind === 'boolean'
      ? { kind, field: raw.field, operator: raw.operator }
      : { kind, field: raw.field, operator: raw.operator, value: quantityValue(kind, raw.value) }
  ) as Predicate;

  const violation = validatePredicateShape(predicate);
  if (violation !== null) {
    ctx.addIssue({ code: 'custom', message: violation });
    return z.NEVER;
  }
  return predicate;
}

const predicateSchema = rawPredicateSchema.transform(validatePredicate);

const ruleBodySchema = z
  .object({
    ruleKey: z.string().min(1),
    predicates: z.array(predicateSchema).min(1),
    outcome: z.enum([...OUTCOME_ORDER]),
    reasonCode: z.enum([...REASON_CODES]),
    note: z.string().max(1000).optional().default(''),
  })
  .strict();

export const publishRulesetRequestSchema = z
  .object({ rules: z.array(ruleBodySchema).min(1) })
  .strict();
