import { z } from 'zod';
import { ACTION_CLASSES } from './action-class.js';
import { ISSUE_KINDS, ISSUE_STATES } from './issue-enums.js';

// The closed record `evaluate()` accepts (contracts/evaluation.md `DecisionInput`). Every group
// is `.strict()`, not only the top level: a confidence value smuggled into, say, `impact` would
// defeat R-03 exactly as one at the top level would.
//
// **No confidence field exists anywhere in this schema.** Not optional, not stripped — absent.
// T007 proves an extra `confidence` key is rejected, not merely ignored.

const codeProblemVerdictSchema = z.enum(['code_problem', 'not_a_code_problem', 'undetermined', 'absent']);

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
    evaluatedAt: z.date(),
  })
  .strict();

export type DecisionInput = z.infer<typeof decisionInputSchema>;
