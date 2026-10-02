import { z } from 'zod';
import { HealerError } from '@healer/shared';
import { ACTION_CLASSES } from './action-class.js';
import { ISSUE_KINDS } from './issue-enums.js';
import type { StoredDecision } from './policy-decision-repository.js';
import { REASON_CODES } from './reason-code.js';

/**
 * What the one human whose click authorises a mutation reads (FR-015, data-model.md
 * `approval_request.summary`, quickstart 18, 003 FR-021).
 *
 * Unrepresentable by construction rather than checked after the fact: there is no caller-supplied
 * field. The summary is built from the **stored `policy_decision`** (closed enums, booleans,
 * counts) and every free-string slot must match the identifier alphabet below — no whitespace —
 * so a sentence of collected customer text has no slot it can occupy; it fails the parse instead
 * of being rendered. Evidence appears only as identifiers (`approval_request.evidence_ids`), never
 * as an excerpt.
 */
const IDENTIFIER = /^[A-Za-z0-9_.:/@#-]{1,200}$/;
const identifier = z.string().regex(IDENTIFIER);

export const approvalSummarySchema = z
  .object({
    proposedAction: identifier,
    actionClass: z.enum(ACTION_CLASSES),
    reasonCodes: z.array(z.enum(REASON_CODES)),
    rulesetVersion: z.number().int().nonnegative(),
    matchedRuleKeys: z.array(identifier),
    target: z
      .object({
        componentId: identifier,
        environment: identifier,
        issueKind: z.enum(ISSUE_KINDS),
        targetRef: identifier,
      })
      .strict(),
    impactSummary: z
      .object({
        classification: identifier,
        touchesPublicContract: z.boolean(),
        touchesMigration: z.boolean(),
        touchesAuthPath: z.boolean(),
        touchesMoneyPath: z.boolean(),
        closureSize: z.number().int().nonnegative(),
        closureMaxDepth: z.number().int().nonnegative(),
      })
      .strict(),
    rollbackPlan: z
      .object({
        reversible: z.boolean(),
        hasTestedUndo: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;

/** A decision field held something that is not an identifier or a structured value. The message
 *  names the field, never its content: the content is exactly what must not be echoed. */
export class ApprovalSummaryNotStructuralError extends HealerError {
  constructor(readonly fields: readonly string[]) {
    super(
      'VALIDATION',
      `approval summary refused: non-structural value in ${fields.join(', ') || 'summary'}`,
    );
    this.name = 'ApprovalSummaryNotStructuralError';
  }
}

export function buildApprovalSummary(decision: StoredDecision): ApprovalSummary {
  if (decision.outcome !== 'require_approval') {
    throw new HealerError(
      'PRECONDITION_FAILED',
      `policy decision ${decision.id} did not resolve to require_approval`,
    );
  }
  const { action, target, impact, reversibility } = decision.decisionInput;
  const parsed = approvalSummarySchema.safeParse({
    proposedAction: decision.actionKey,
    actionClass: action.actionClass,
    reasonCodes: [...decision.reasonCodes],
    rulesetVersion: decision.rulesetVersion,
    matchedRuleKeys: [...decision.matchedRuleKeys],
    target: {
      componentId: target.componentId,
      environment: target.environment,
      issueKind: target.issueKind,
      targetRef: target.targetRef,
    },
    impactSummary: {
      classification: impact.classification,
      touchesPublicContract: impact.touchesPublicContract,
      touchesMigration: impact.touchesMigration,
      touchesAuthPath: impact.touchesAuthPath,
      touchesMoneyPath: impact.touchesMoneyPath,
      closureSize: impact.closure.memberIds.length,
      closureMaxDepth: impact.closure.maxDepth,
    },
    rollbackPlan: {
      reversible: reversibility.reversible,
      hasTestedUndo: reversibility.hasTestedUndo,
    },
  });
  if (!parsed.success) {
    throw new ApprovalSummaryNotStructuralError(
      parsed.error.issues.map((issue) => issue.path.join('.')),
    );
  }
  return parsed.data;
}
