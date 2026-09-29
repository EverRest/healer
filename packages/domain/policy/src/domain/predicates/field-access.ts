import type { DecisionInput } from '../decision-input.js';
import type { ImpactClosure } from '../impact-closure.js';
import type {
  BooleanField,
  ClosureField,
  EnumeratedField,
  IdentifierField,
  InstantField,
  OrdinalField,
  QuantityField,
} from './fields.js';

// Explicit switches, not a generic dotted-path walker: the field list is the closed vocabulary
// (fields.ts), so every case is enumerable and TypeScript proves the switch is exhaustive — a
// field added to one list without a case here is a compile error, not a runtime throw (T010: "no
// operator ever throws for a well-typed input").

function unreachable(value: never): never {
  throw new Error(`unreachable field: ${String(value)}`);
}

export function readEnumeratedField(field: EnumeratedField, input: DecisionInput): string {
  switch (field) {
    case 'target.environment':
      return input.target.environment;
    case 'target.issueKind':
      return input.target.issueKind;
    case 'issue.classification':
      return input.issue.classification;
    case 'impact.classification':
      return input.impact.classification;
    case 'action.actionClass':
      return input.action.actionClass;
    case 'reproduction.outcome':
      return input.reproduction.outcome;
    case 'issue.state':
      return input.issue.state;
    case 'eligibility.codeProblemVerdict':
      return input.eligibility.codeProblemVerdict;
    default:
      return unreachable(field);
  }
}

export function readIdentifierField(field: IdentifierField, input: DecisionInput): string {
  switch (field) {
    case 'target.componentId':
      return input.target.componentId;
    case 'target.targetRef':
      return input.target.targetRef;
    case 'target.fingerprint':
      return input.target.fingerprint;
    case 'action.actionKey':
      return input.action.actionKey;
    default:
      return unreachable(field);
  }
}

export function readBooleanField(field: BooleanField, input: DecisionInput): boolean {
  switch (field) {
    case 'evidence.complete':
      return input.evidence.complete;
    case 'evidence.conclusionHasLink':
      return input.evidence.conclusionHasLink;
    case 'reversibility.reversible':
      return input.reversibility.reversible;
    case 'reversibility.hasTestedUndo':
      return input.reversibility.hasTestedUndo;
    case 'eligibility.fixEligible':
      return input.eligibility.fixEligible;
    case 'impact.touchesPublicContract':
      return input.impact.touchesPublicContract;
    case 'impact.touchesMigration':
      return input.impact.touchesMigration;
    case 'impact.touchesAuthPath':
      return input.impact.touchesAuthPath;
    case 'impact.touchesMoneyPath':
      return input.impact.touchesMoneyPath;
    default:
      return unreachable(field);
  }
}

export function readOrdinalField(field: OrdinalField, input: DecisionInput): number {
  switch (field) {
    case 'autonomy.level':
      return input.autonomy.level;
    case 'budget.degradationStep':
      return input.budget.degradationStep;
    default:
      return unreachable(field);
  }
}

export function readQuantityField(field: QuantityField, input: DecisionInput): number {
  switch (field) {
    case 'budget.consumed':
      return input.budget.consumed;
    case 'budget.limit':
      return input.budget.limit;
    case 'budget.declaredMaxCost':
      return input.budget.declaredMaxCost;
    case 'cooldown.recentAllowCount':
      return input.cooldown.recentAllowCount;
    case 'cooldown.attemptCount':
      return input.cooldown.attemptCount;
    case 'escalation.attemptCount':
      return input.escalation.attemptCount;
    default:
      return unreachable(field);
  }
}

export function readInstantField(field: InstantField, input: DecisionInput): Date {
  switch (field) {
    case 'evaluatedAt':
      return input.evaluatedAt;
    default:
      return unreachable(field);
  }
}

export function readClosureField(field: ClosureField, input: DecisionInput): ImpactClosure {
  switch (field) {
    case 'impact.closure':
      return input.impact.closure;
    default:
      return unreachable(field);
  }
}
