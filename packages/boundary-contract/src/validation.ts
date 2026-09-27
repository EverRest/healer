import { RunnerEvidence, type RunnerEvidence as RunnerEvidenceType } from './index.js';

/**
 * Egress (runner) and ingress (control plane) validation (012 T041, FR-022) — two distinct call
 * sites against the same closed schema, not one validation whose result both sides trust. A
 * payload failing egress is never sent; one failing ingress is rejected and counted, because the
 * runner that sent it is not this process's own code in this release (a customer can run an
 * older image), so the control plane never assumes the sender validated correctly.
 */
export interface ValidationResult {
  readonly ok: boolean;
  readonly evidence?: RunnerEvidenceType;
  readonly errors?: readonly string[];
}

function validate(payload: unknown): ValidationResult {
  const result = RunnerEvidence.safeParse(payload);
  if (result.success) return { ok: true, evidence: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  };
}

/** Runner-side: a payload failing this is not sent. */
export function validateEgress(payload: unknown): ValidationResult {
  return validate(payload);
}

/** Control-plane-side: independent of egress — a payload failing this is rejected and counted. */
export function validateIngress(payload: unknown): ValidationResult {
  return validate(payload);
}
