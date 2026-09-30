import { z } from 'zod';
import { ACTION_CLASSES } from './action-class.js';
import { ISSUE_KINDS, ISSUE_STATES } from './issue-enums.js';

// The closed record `evaluate()` accepts (contracts/evaluation.md `DecisionInput`). Every group
// is `.strict()`, not only the top level: a confidence value smuggled into, say, `impact` would
// defeat R-03 exactly as one at the top level would.
//
// **No confidence field exists anywhere in this schema.** Not optional, not stripped — absent.
// T007 proves an extra `confidence` key is rejected, not merely ignored.

const codeProblemVerdictSchema = z.enum([
  'code_problem',
  'not_a_code_problem',
  'undetermined',
  'absent',
]);

const reproductionOutcomeSchema = z.enum(['pass', 'fail', 'inconclusive', 'absent']);

const impactClosureSchema = z
  .object({
    memberIds: z.array(z.string()),
    maxDepth: z.number().int().nonnegative(),
  })
  .strict();

export const decisionInputSchema = z
  .object({
    action: z
      .object({
        actionKey: z.string().min(1),
        actionClass: z.enum(ACTION_CLASSES),
      })
      .strict(),
    target: z
      .object({
        componentId: z.string().min(1),
        environment: z.string().min(1),
        issueKind: z.enum(ISSUE_KINDS),
        targetRef: z.string().min(1),
        fingerprint: z.string().min(1),
      })
      .strict(),
    issue: z
      .object({
        state: z.enum(ISSUE_STATES),
        // The taxonomy class 006's classifier assigns (006 FR-001) — 006 has not landed, so the
        // domain value is not yet a closed list here; `environment` below is the same situation
        // and the same choice prisma/schema.prisma already made for `issue.environment`.
        classification: z.string().min(1),
      })
      .strict(),
    eligibility: z
      .object({
        codeProblemVerdict: codeProblemVerdictSchema,
        fixEligible: z.boolean(),
      })
      .strict(),
    evidence: z
      .object({
        complete: z.boolean(),
        conclusionHasLink: z.boolean(),
      })
      .strict(),
    reproduction: z
      .object({
        outcome: reproductionOutcomeSchema,
      })
      .strict(),
    impact: z
      .object({
        // 008's impact classification (spec.md L247) — not yet a closed list in this repo.
        classification: z.string().min(1),
        touchesPublicContract: z.boolean(),
        touchesMigration: z.boolean(),
        touchesAuthPath: z.boolean(),
        touchesMoneyPath: z.boolean(),
        closure: impactClosureSchema,
      })
      .strict(),
    reversibility: z
      .object({
        reversible: z.boolean(),
        hasTestedUndo: z.boolean(),
      })
      .strict(),
    autonomy: z
      .object({
        level: z.number().int().min(0).max(5),
      })
      .strict(),
    budget: z
      .object({
        consumed: z.number().nonnegative(),
        limit: z.number().nonnegative(),
        declaredMaxCost: z.number().nonnegative(),
        degradationStep: z.number().int().nonnegative(),
      })
      .strict(),
    cooldown: z
      .object({
        recentAllowCount: z.number().int().nonnegative(),
        windowSeconds: z.number().int().nonnegative(),
        attemptCount: z.number().int().nonnegative(),
      })
      .strict(),
    escalation: z
      .object({
        attemptCount: z.number().int().nonnegative(),
      })
      .strict(),
    // Not `z.date()` alone (batch 9 C2, review finding): `decision_input` round-trips through
    // JSONB, which has no `Date` type — `evaluatedAt` comes back a string, and `matchesInstant`'s
    // `.getTime()` throws on a string. Coercing here means every reader that parses stored JSONB
    // through this schema (`toStoredDomain`, below) gets a real `Date` back, not only the one
    // caller (replay) that happened to hit the crash first.
    //
    // Not bare `z.coerce.date()` either (follow-up review finding): `z.coerce.date()` calls
    // `new Date(x)` on *any* input, so `null` -> 1970-01-01, `true`/a bare number also silently
    // become dates — exactly the class of caller mistake `z.date()` used to reject outright. The
    // union restricts coercion to the two shapes that should ever produce a date here: an actual
    // `Date` (a same-process caller) or a proper ISO datetime string (JSONB's round-trip, and
    // `dry-run.dto.ts`'s HTTP body) — `z.string().datetime({ offset: true })` rejects anything
    // that isn't a real ISO 8601 datetime before coercion ever runs, so `null`/`true`/a bare
    // number are refused exactly as they were under `z.date()`, and a real value still coerces.
    evaluatedAt: z.union([z.date(), z.string().datetime({ offset: true })]).pipe(z.coerce.date()),
  })
  .strict();

export type DecisionInput = z.infer<typeof decisionInputSchema>;
