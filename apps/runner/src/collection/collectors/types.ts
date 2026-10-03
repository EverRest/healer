import {
  COLLECTOR_PARAMETER_SCHEMAS,
  type CollectorKey,
  type GapReasonCode,
  type ItemClass,
  type RunnerEvidence,
} from '@healer/boundary-contract';
import { scope, type TenantContext, type TenantScoped } from '@healer/shared';

/**
 * What a collector hands the clearing pipeline (003 T016): a structural shape the collector
 * derived in closed form, plus — only where an excerpt is wanted — the raw text it came from.
 * The collector never decides what crosses; `clear.ts` does, for every collector alike, so there
 * is exactly one place where "nothing raw crosses" is implemented (FR-007).
 */
export interface Candidate {
  readonly kind: 'candidate';
  readonly itemClass: ItemClass;
  readonly evidence: RunnerEvidence;
  readonly observedAt: Date;
  /** Where the original lives in the source — enough for a human to find it again (R-08). */
  readonly sourceLocator: string;
  /** Raw text an excerpt may be derived from. Never sent as-is; absent when no excerpt is wanted. */
  readonly rawText?: string;
  /**
   * The whole source record this candidate was derived from. It is screened by the whole-item
   * detectors but never sent: a record that must be withheld withholds every item derived from it,
   * not just the one that carried the excerpt.
   */
  readonly guardText?: string;
}

/** A record whose format the ruleset does not recognise: withheld, never guessed at (FR-009). */
export interface Unrecognised {
  readonly kind: 'unrecognised';
  readonly itemClass: ItemClass;
  readonly observedAt: Date;
  readonly sourceLocator: string;
  readonly original: string;
}

export interface CollectorOutput {
  readonly candidates: readonly (Candidate | Unrecognised)[];
  /** The source had more than `maxItems` to give. */
  readonly capped: boolean;
}

/** A collector's reasoned refusal — the closed reason a downstream step branches on (R-07). */
export class CollectorFailure extends Error {
  constructor(
    readonly reasonCode: GapReasonCode,
    message: string,
  ) {
    super(message);
    this.name = 'CollectorFailure';
  }
}

export interface CollectContext {
  readonly window: { readonly from: Date; readonly to: Date };
  readonly maxItems: number;
  readonly signal?: AbortSignal;
}

/**
 * The port to a customer system, bound to credentials that exist only in this plane (FR-002).
 * It returns `unknown`: whatever a source hands back is untrusted until a collector's own schema
 * has parsed it, and a record that does not parse is `Unrecognised`, not a crash.
 */
export interface SourcePort {
  read(request: {
    readonly component: string;
    readonly environment: string;
    readonly window: CollectContext['window'];
    readonly limit: number;
    /** Named repository-relative paths — only the follow-up `source_file` collector sets this. */
    readonly paths?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<readonly unknown[]>;
}

/**
 * One collector run, tenant-scoped (T013, FR-023): a plain object is not assignable, so an
 * invocation built without a `TenantContext` fails to type-check, and `collect` accepts only this.
 * Parameters are the collector's own declared schema, parsed — never a query or an expression.
 */
export type CollectorInvocation = TenantScoped<{
  readonly collectorKey: CollectorKey;
  readonly parameters: Readonly<Record<string, unknown>>;
}>;

export function invocationFor(
  context: TenantContext,
  collectorKey: CollectorKey,
  rawParameters: unknown,
): CollectorInvocation {
  const parameters = COLLECTOR_PARAMETER_SCHEMAS[collectorKey].parse(rawParameters) as Record<
    string,
    unknown
  >;
  return scope(context, { collectorKey, parameters });
}

export interface Collector {
  readonly key: CollectorKey;
  collect(invocation: CollectorInvocation, ctx: CollectContext): Promise<CollectorOutput>;
}
