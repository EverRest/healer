import { z } from 'zod';
import {
  fieldKindOf,
  OPERATORS_BY_KIND,
  OUTCOME_ORDER,
  QUANTITY_FIELDS,
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
 * `evaluate-predicate.ts`'s own comment names this exact gap: "publish-time validation ... is
 * meant to catch this before it gets this far". `fieldKindOf`/`OPERATORS_BY_KIND` and
 * `validatePredicateShape` (batch 9 I2, review finding) are the domain package's single runtime
 * authority for the predicate vocabulary — this file used to hand-copy `OPERATORS_BY_KIND`, an
 * untested second table that could silently drift from `contracts/evaluation.md`'s own; it now
 * only turns a raw wire object `{field, operator, value}` (no `kind`; JSON has no discriminated
 * unions) into the domain's typed `Predicate`, and delegates every semantic check — including the
 * two gaps `validatePredicateShape` closes (same-quantity-group comparison, unparseable instant
 * literals) — to the same function `publishRuleset` calls in-process, so the HTTP edge and a
 * bypassing caller are checked identically.
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
  if (!OPERATORS_BY_KIND[kind].includes(raw.operator)) {
    ctx.addIssue({
      code: 'custom',
      message: `operator "${raw.operator}" is outside the domain of field "${raw.field}"`,
    });
    return z.NEVER;
  }

  const value = quantityValue(kind, raw.value);
  const valueSchema = VALUE_SCHEMA_BY_KIND_AND_OPERATOR[kind](raw.operator);
  const parsedValue = valueSchema.safeParse(value);
  if (!parsedValue.success) {
    ctx.addIssue({
      code: 'custom',
      message: `predicate value for field "${raw.field}" operator "${raw.operator}" has the wrong type`,
    });
    return z.NEVER;
  }

  // Boolean predicates carry no `value` in the domain shape (`predicates/types.ts`) — whatever
  // the caller sent for it is validated above (a caller may omit it entirely) and then dropped.
  const predicate = (
    kind === 'boolean'
      ? { kind, field: raw.field, operator: raw.operator }
      : { kind, field: raw.field, operator: raw.operator, value: parsedValue.data }
  ) as Predicate;

  // The two gaps this batch closes (same-quantity-group comparison, unparseable instant literals)
  // live in `validatePredicateShape` — the same function `publishRuleset` calls in-process, so
  // the wire path and a bypassing caller reject the same malformed predicates for the same reason.
  const violation = validatePredicateShape(predicate);
  if (violation !== null) {
    ctx.addIssue({ code: 'custom', message: violation });
    return z.NEVER;
  }
  return predicate;
}

const STRING = z.string();
const STRING_ARRAY = z.array(z.string());
const NUMBER = z.number();
const QUANTITY_VALUE = z.union([
  z.object({ kind: z.literal('literal'), value: z.number() }).strict(),
  z.object({ kind: z.literal('field'), field: z.enum([...QUANTITY_FIELDS]) }).strict(),
]);

const VALUE_SCHEMA_BY_KIND_AND_OPERATOR: Record<Kind, (operator: string) => z.ZodTypeAny> = {
  enumerated: (op) => (op === 'in' || op === 'notIn' ? STRING_ARRAY : STRING),
  identifier: (op) => (op === 'in' || op === 'notIn' ? STRING_ARRAY : STRING),
  boolean: () => z.unknown(),
  ordinal: () => NUMBER,
  quantity: () => QUANTITY_VALUE,
  instant: () => STRING,
  closure: (op) => (op === 'sizeAtMost' || op === 'maxDepthAtMost' ? NUMBER : STRING_ARRAY),
};

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
