import type {
  CollectionResultBatch,
  CollectorKey,
  DetectorKey,
  RunnerEvidence,
} from '@healer/boundary-contract';
import type { Candidate, Unrecognised } from './collectors/types.js';
import type { Redactor } from './redaction/redactor.js';
import type { FsWithholdingLedger } from './withholding-ledger.js';

type ResultItem = CollectionResultBatch['items'][number];

export type Cleared =
  | { readonly status: 'crossed'; readonly item: ResultItem }
  | { readonly status: 'withheld'; readonly item: ResultItem };

/**
 * Per-source memory so that every item derived from one source record shares one screening and one
 * ledger entry — a withheld 200 KB record with ten frames is one file on disk, not eleven.
 */
export interface ClearMemo {
  readonly screens: Map<string, DetectorKey | null>;
  readonly refs: Map<string, string>;
}
export const newClearMemo = (): ClearMemo => ({ screens: new Map(), refs: new Map() });

export interface ClearDeps {
  readonly memo?: ClearMemo;
  /** `undefined` when the ruleset version the plan names is unknown to this image: everything is withheld (FR-009). */
  readonly redactor: Redactor | undefined;
  readonly ledger: FsWithholdingLedger;
  readonly rulesetVersion: number;
  readonly collectorKey: CollectorKey;
}

/**
 * The one place "nothing raw crosses" is decided (003 T016–T020, FR-007, FR-009). Every collector's
 * output passes through here; a collector cannot cross anything by another route.
 *
 *   unrecognised format ──────────────────────────────────────────▶ withheld
 *   the source record trips a whole-item detector ────────────────▶ withheld
 *   structural fields scrubbed: whole-item detector fires ────────▶ withheld
 *   excerpt: whole-item detector fires ───────────────────────────▶ withheld
 *   excerpt: free text / truncated / no signal left ──────────────▶ crosses, original stays local
 *   otherwise ────────────────────────────────────────────────────▶ crosses
 *
 * A withheld item crosses as a `collection_gap` carrying `{ localRef, itemClass, reasonCode,
 * collectorKey, observedAt }` and nothing of its content: the original stays in the plane-local
 * ledger under a fresh UUID (R-08). There is no truncated-and-sent outcome.
 */
export function clear(candidate: Candidate | Unrecognised, deps: ClearDeps): Cleared {
  const { redactor } = deps;
  if (candidate.kind === 'unrecognised' || redactor === undefined) {
    // No ruleset, or a format it cannot read: `free_text_span` is the default-deny that stands behind both.
    const original =
      candidate.kind === 'unrecognised'
        ? candidate.original
        : (candidate.guardText ?? candidate.rawText ?? JSON.stringify(candidate.evidence));
    return withhold(candidate, original, 'free_text_span', deps);
  }

  const shape = clearShape(candidate, redactor, deps.memo);
  if (shape.status === 'withheld') return withhold(candidate, shape.original, shape.detector, deps);

  const base = {
    evidence: shape.value,
    collectorKey: deps.collectorKey,
    observedAt: candidate.observedAt.toISOString(),
    redactionRulesetVersion: deps.rulesetVersion,
  };
  if (candidate.rawText === undefined) {
    return { status: 'crossed', item: { ...base, redactionDominated: false } };
  }

  const excerpt = redactor.clearExcerpt(candidate.rawText);
  if (excerpt.status === 'withheld') {
    return withhold(candidate, candidate.rawText, excerpt.detector, deps);
  }
  // Reduced, not withheld: what crosses is bounded and cleared, and a human can look locally (R-08).
  const localRef =
    excerpt.truncated || excerpt.redactionDominated
      ? deps.ledger.record({
          kind: 'reduced',
          collectorKey: deps.collectorKey,
          itemClass: candidate.itemClass,
          sourceLocator: candidate.sourceLocator,
          original: candidate.rawText,
          observedAt: candidate.observedAt,
        }).localRef
      : undefined;
  return {
    status: 'crossed',
    item: {
      ...base,
      ...(excerpt.text !== undefined
        ? { excerpt: { text: excerpt.text, truncated: excerpt.truncated } }
        : {}),
      redactionDominated: excerpt.redactionDominated,
      ...(localRef !== undefined ? { localRef } : {}),
    },
  };
}

type ShapeOutcome =
  | { readonly status: 'clear'; readonly value: RunnerEvidence }
  | { readonly status: 'withheld'; readonly detector: DetectorKey; readonly original: string };

/** The whole source record is screened first, so a record that must be withheld withholds every item derived from it. */
function clearShape(candidate: Candidate, redactor: Redactor, memo?: ClearMemo): ShapeOutcome {
  const screened = screenOnce(candidate.guardText, redactor, memo);
  if (screened !== undefined) {
    return { status: 'withheld', detector: screened, original: candidate.guardText ?? '' };
  }
  const scrubbed = redactor.scrubShape(candidate.evidence);
  if (scrubbed.status === 'withheld') {
    return {
      status: 'withheld',
      detector: scrubbed.detector,
      original: candidate.rawText ?? JSON.stringify(candidate.evidence),
    };
  }
  return scrubbed;
}

function screenOnce(
  record: string | undefined,
  redactor: Redactor,
  memo?: ClearMemo,
): DetectorKey | undefined {
  if (record === undefined) return undefined;
  const cached = memo?.screens.get(record);
  if (cached !== undefined) return cached ?? undefined;
  const found = redactor.screen(record);
  memo?.screens.set(record, found ?? null);
  return found;
}

function withhold(
  candidate: Candidate | Unrecognised,
  original: string,
  detector: DetectorKey,
  deps: ClearDeps,
): Cleared {
  const localRef =
    deps.memo?.refs.get(original) ??
    deps.ledger.record({
      kind: 'withheld',
      collectorKey: deps.collectorKey,
      itemClass: candidate.itemClass,
      reasonCode: 'redaction_withheld',
      detector,
      sourceLocator: candidate.sourceLocator,
      original,
      observedAt: candidate.observedAt,
    }).localRef;
  deps.memo?.refs.set(original, localRef);
  const observedAt = candidate.observedAt.toISOString();
  return {
    status: 'withheld',
    item: {
      evidence: {
        kind: 'collection_gap',
        what: candidate.itemClass,
        why: 'redaction_withheld',
        withheldByRedaction: true,
        collectorKey: deps.collectorKey,
        reasonCode: 'redaction_withheld',
        detector,
        itemClass: candidate.itemClass,
        localRef,
        observedAt,
      },
      collectorKey: deps.collectorKey,
      observedAt,
      redactionDominated: false,
      redactionRulesetVersion: deps.rulesetVersion,
    },
  };
}
