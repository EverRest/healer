import { createHash, randomUUID } from 'node:crypto';
import {
  DuplicateEvidenceLinkError,
  type ConclusionType,
  type Evidence,
  type EvidenceLinkRepository,
  type EvidenceRelation,
  type EvidenceRepository,
} from '@healer/domain-evidence';
import { currentStep, scope, type TenantContext } from '@healer/shared';
import { unwrapUntrusted } from '../domain/untrusted-text.js';
import {
  excerptAround,
  toDocumentExcerptPayload,
  type DocumentResult,
} from './document-excerpt-payload.js';

export interface RecordDocumentExcerptDeps {
  readonly evidence: EvidenceRepository;
  readonly links: EvidenceLinkRepository;
  readonly now: () => Date;
  /** Evidence retention, supplied by configuration (R-10: expiry runs from receipt). */
  readonly retentionMs: number;
}

/**
 * Deliberately no `producedByStep` and no tenant: the step is the one executing right now
 * (`currentStep()`), the tenant is the `TenantContext`. `result` is the document arm only.
 */
export interface RecordDocumentExcerptCommand {
  readonly issueId: string;
  readonly result: DocumentResult;
  /** Length of the cited section, when the caller has it; the span must lie within it. */
  readonly sectionLength?: number;
  /** When the retrieving step already knows the conclusion this excerpt bears on, the link is
   *  written in this same call, attributed to this same step. Never added afterwards. */
  readonly conclusion?: {
    readonly type: ConclusionType;
    readonly id: string;
    readonly relation: EvidenceRelation;
  };
}

/** Deterministic id (UUID-shaped sha-256), so a re-run names the row it already wrote. */
function evidenceId(parts: readonly (string | number)[]): string {
  const h = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const variant = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Canonical form of the payload minus `recordedAt` (sorted keys, so JSONB re-ordering is harmless). */
function snapshotKey(payload: Readonly<Record<string, unknown>>): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  const { recordedAt: _recordedAt, ...rest } = payload;
  return createHash('sha256')
    .update(JSON.stringify(canon(rest)))
    .digest('hex');
}

/**
 * `RecordDocumentExcerptEvidence` (005 T021, FR-025): the retrieving step records, about itself, the
 * document excerpt it used with the tier and freshness AT THAT MOMENT, pinned to the document
 * version (FR-019). Goes through 001's append-only `EvidenceRepository`; `recordEvidence` cannot be
 * used because it validates against 012's runner boundary kinds, which has none for a document
 * (see its own doc comment), so the payload is validated by this feature's strict schema instead.
 *
 * Idempotent (jobs may run twice): same (tenant, issue, step, version, section, span, snapshot) is
 * the same row. There is no API recording for another step, and no way to link after the fact.
 */
export async function recordDocumentExcerptEvidence(
  deps: RecordDocumentExcerptDeps,
  context: TenantContext,
  command: RecordDocumentExcerptCommand,
): Promise<Evidence> {
  const step = currentStep();
  if (step === undefined) {
    throw new Error('recordDocumentExcerptEvidence must run inside a step (withStep)');
  }
  const { result } = command;
  const text = unwrapUntrusted(result.content, 'evidence');
  const [spanStart, spanEnd] = result.matchedSpan;
  if (
    spanEnd > text.length ||
    (command.sectionLength !== undefined && spanEnd > command.sectionLength)
  ) {
    throw new RangeError('matchedSpan lies outside the section it cites');
  }
  const at = deps.now();
  const window = excerptAround(text, result.matchedSpan);
  const payload = toDocumentExcerptPayload(result, at, window.start);
  const snapshot = snapshotKey(payload);
  // The snapshot is part of the identity: same facts, same row (a job run twice); a changed tier,
  // rule set, freshness, provenance or detachment is a new observation, never the first one reused.
  const id = evidenceId([
    context.tenantId,
    command.issueId,
    step,
    result.documentVersionId,
    result.sectionId,
    spanStart,
    spanEnd,
    snapshot,
  ]);
  const where = scope(context, { id });

  let row = await deps.evidence.findById(where);
  if (row === null) {
    try {
      row = await deps.evidence.record(
        scope(context, {
          id,
          issueId: command.issueId,
          type: 'document_excerpt',
          sourceSystem: 'knowledge',
          sourceRef: `${result.documentVersionId}#${result.sectionId}:${spanStart}-${spanEnd}`,
          sourceLabel: result.originRef,
          payload,
          producedByStep: step,
          observedAt: at,
          expiresAt: new Date(at.getTime() + deps.retentionMs),
          excerpt: window.excerpt,
          excerptTruncated: window.truncated,
        }),
      );
    } catch (error) {
      // A concurrent twin may have won the insert: converge only on a row holding the same snapshot.
      row = await deps.evidence.findById(where);
      if (row === null || snapshotKey(row.payload) !== snapshot) throw error;
    }
  }

  if (command.conclusion !== undefined) {
    try {
      await deps.links.write(
        scope(context, {
          // Random on purpose: only (evidence, conclusion, relation) may collide, so the
          // repository can map that to DuplicateEvidenceLinkError (a fixed id hits the pkey first).
          id: randomUUID(),
          evidenceId: id,
          conclusionType: command.conclusion.type,
          conclusionId: command.conclusion.id,
          relation: command.conclusion.relation,
        }),
      );
    } catch (error) {
      if (!(error instanceof DuplicateEvidenceLinkError)) throw error;
    }
  }
  return row;
}
