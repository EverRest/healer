import { validateIngress } from '@healer/boundary-contract';
import { scope, type TenantContext } from '@healer/shared';
import { boundExcerpt } from '../../domain/excerpt.js';
import type { EvidenceRepository } from '../../domain/repository.js';
import type { Evidence, EvidenceType } from '../../domain/types.js';

/**
 * Rejected by boundary validation (012 T041) before ever reaching the repository — the payload
 * does not match the shape its own `kind` declares.
 */
export class InvalidEvidencePayloadError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`evidence payload failed boundary validation: ${issues.join('; ')}`);
    this.name = 'InvalidEvidencePayloadError';
  }
}

/**
 * A real `RunnerEvidence` kind (012's boundary contract), but not one this feature persists as
 * `Evidence` (FR-007a: "a consumer needing a new kind of evidence... MUST have it added here").
 * `agent_run_report` is the concrete example — it becomes 012's own `agent_run` row (ADR 0010),
 * never an `Evidence` row; deciding that is not this function's job, only recognizing it isn't
 * one of the kinds `KIND_TO_EVIDENCE_TYPE` owns.
 */
export class UnrecognizedEvidenceKindError extends Error {
  constructor(readonly kind: string) {
    super(`"${kind}" is not an evidence kind this feature persists (FR-007a)`);
    this.name = 'UnrecognizedEvidenceKindError';
  }
}

/**
 * The one authority for which transport `kind` (012's boundary contract) becomes which
 * `Evidence.type` (FR-007a) — a closed list, not restated anywhere else. The four
 * architecture-discovery shapes crossing the runner boundary all collapse to the single type
 * `graph_fact`: the transport contract is closed per fact family, the evidence type answers "what
 * did we observe about the architecture", which is one kind of observation regardless of which
 * of the four produced it.
 */
const KIND_TO_EVIDENCE_TYPE: Readonly<Record<string, EvidenceType>> = {
  error_signature: 'error_signature',
  trace_shape: 'trace_shape',
  metric_delta: 'metric_delta',
  deploy_ref: 'deploy_ref',
  commit_ref: 'commit_ref',
  test_result: 'test_result',
  file_path: 'file_path',
  tool_output_summary: 'tool_output_summary',
  collection_gap: 'collection_gap',
  component_candidate: 'graph_fact',
  deployment_unit_candidate: 'graph_fact',
  dependency_observation: 'graph_fact',
  repository_ref: 'graph_fact',
};

/**
 * Excerpt size limit (R-05, FR-011): `docs/stage-0.md` S0-7 names this exact value as
 * deliberately left unset in the spec, pending S0-1's incident-cadence data. 64 KiB (in Unicode
 * code points, matching `boundExcerpt`) is a placeholder — a common log-excerpt default, not a
 * measured one — and belongs behind per-tenant configuration once that exists, same status as
 * the reopen window (001 T022).
 */
const EXCERPT_MAX_LENGTH = 65_536;

export interface RecordEvidenceInput {
  readonly id: string;
  readonly issueId: string;
  readonly sourceSystem: string;
  readonly sourceRef: string;
  readonly sourceLabel: string;
  readonly producedByStep: string;
  readonly observedAt: Date;
  readonly expiresAt: Date;
  readonly excerpt?: string | null;
}

/**
 * `RecordEvidence` (001 T027, FR-007, FR-007a): validates a raw payload against 012's boundary
 * schemas before it becomes a stored `Evidence` row — `Evidence.payload`'s own doc comment
 * ("schema-validated, no free-form strings... not enforced by this type") named this exact gap.
 *
 * `document_excerpt` and `budget_degradation` are real `Evidence.type` values with no boundary
 * schema here on purpose: neither crosses the runner boundary (a document is read by the control
 * plane directly; a budget degradation is 002's own emission), so 012 T041 never defined one for
 * them. Not built here — flagged in QUESTIONS.md rather than invented ahead of 002/005.
 */
export async function recordEvidence(
  repo: EvidenceRepository,
  context: TenantContext,
  input: RecordEvidenceInput,
  rawPayload: unknown,
): Promise<Evidence> {
  const result = validateIngress(rawPayload);
  if (!result.ok || result.evidence === undefined) {
    throw new InvalidEvidencePayloadError(result.errors ?? ['unknown validation failure']);
  }

  const type = KIND_TO_EVIDENCE_TYPE[result.evidence.kind];
  if (type === undefined) {
    throw new UnrecognizedEvidenceKindError(result.evidence.kind);
  }

  const excerptFields = boundExcerpt(input.excerpt ?? null, EXCERPT_MAX_LENGTH);

  return repo.record(
    scope(context, {
      id: input.id,
      issueId: input.issueId,
      type,
      sourceSystem: input.sourceSystem,
      sourceRef: input.sourceRef,
      sourceLabel: input.sourceLabel,
      payload: result.evidence,
      producedByStep: input.producedByStep,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
      ...excerptFields,
    }),
  );
}
