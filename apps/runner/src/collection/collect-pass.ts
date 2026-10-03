import {
  COLLECTION_CONTRACT_VERSION,
  type CollectionPlanDirective,
  CollectionResultItem,
  type CollectionResultBatch,
  type CollectorKey,
  type ItemClass,
  type GapReasonCode,
  type SourceOutcome,
} from '@healer/boundary-contract';
import type { TenantContext } from '@healer/shared';
import { clear, newClearMemo } from './clear.js';
import { egress } from './egress.js';
import { CollectorFailure, invocationFor, type Collector } from './collectors/types.js';
import type { Redactor } from './redaction/redactor.js';
import type { FsWithholdingLedger } from './withholding-ledger.js';

export interface CollectPassDeps {
  readonly tenant: TenantContext;
  /** What this image has bound to local credentials; a planned collector absent here is `capability_unavailable`. */
  readonly collectors: Partial<Record<CollectorKey, Collector>>;
  readonly redactor: Redactor | undefined;
  readonly ledger: FsWithholdingLedger;
  readonly runnerImageVersion: string;
  readonly now?: () => Date;
  /** Hears of a source that failed, by collector and error *name* only — never a message (it may quote data). */
  readonly onSourceError?: (collectorKey: CollectorKey, errorName: string) => void;
}

type ResultItem = CollectionResultBatch['items'][number];
type Request = CollectionPlanDirective['collectors'][number];
type Outcome = Omit<SourceOutcome, 'collectorKey' | 'durationMs'>;

/**
 * One directive in, one result batch out (003 T016, R-06). Collectors run one after another here;
 * the bounded concurrent pool with per-source timeouts is T034 and replaces this loop — nothing in
 * the batch's shape depends on it. Whatever happens inside a source, the pass produces a batch
 * with an outcome for every planned collector (FR-015): a failure is a status, never an exception,
 * and the failure's own message is never copied out (it may quote the data it choked on).
 */
export async function collectPass(
  plan: CollectionPlanDirective,
  deps: CollectPassDeps,
): Promise<CollectionResultBatch> {
  const now = deps.now ?? (() => new Date());
  // Retention is enforced, not merely hidden: expired plaintext originals are removed.
  try {
    deps.ledger.pruneExpired();
  } catch {
    // an unreadable ledger directory must not stop collection; resolve() still hides expired entries
  }
  const items: ResultItem[] = [];
  const sourceOutcomes: SourceOutcome[] = [];

  for (const request of plan.collectors) {
    const started = now().getTime();
    const outcome = await collectOne(request, plan, deps, items);
    sourceOutcomes.push({
      collectorKey: request.collectorKey,
      durationMs: Math.max(0, now().getTime() - started),
      ...outcome,
    });
  }

  return egress({
    passId: plan.passId,
    planDigest: plan.planDigest,
    contractVersion: COLLECTION_CONTRACT_VERSION,
    runnerImageVersion: deps.runnerImageVersion,
    collectedAt: now().toISOString(),
    sourceOutcomes,
    items,
  });
}

async function collectOne(
  request: Request,
  plan: CollectionPlanDirective,
  deps: CollectPassDeps,
  items: ResultItem[],
): Promise<Outcome> {
  const collector = deps.collectors[request.collectorKey];
  if (collector === undefined) {
    return {
      status: 'not_attempted',
      reasonCode: 'capability_unavailable',
      itemCount: 0,
      truncated: false,
    };
  }
  try {
    const output = await collector.collect(
      invocationFor(deps.tenant, request.collectorKey, request.parameters),
      {
        window: { from: new Date(plan.window.from), to: new Date(plan.window.to) },
        maxItems: plan.budget.maxItemsPerCollector,
      },
    );
    // The cap holds for every candidate — unrecognised records and derived frames included — and
    // is applied here, once, so no collector can forget it.
    const max = plan.budget.maxItemsPerCollector;
    const capped = output.capped || output.candidates.length > max;
    const clearDeps = {
      redactor: deps.redactor,
      ledger: deps.ledger,
      rulesetVersion: plan.redactionRulesetVersion,
      collectorKey: request.collectorKey,
      memo: newClearMemo(),
    };
    // Built locally and merged only when the whole source succeeded: a failure halfway (a full
    // disk) must not leave orphan items under an "unavailable, 0 items" outcome.
    const local: ResultItem[] = [];
    let crossed = 0;
    let withheld = 0;
    let rejected = 0;
    for (const candidate of output.candidates.slice(0, max)) {
      const cleared = clear(candidate, clearDeps);
      if (!CollectionResultItem.safeParse(cleared.item).success) {
        // The schema refused what we built: that item becomes a recorded gap, not an exception
        // that discards every other collector's items (FR-015).
        local.push(
          schemaRejectedGap(
            request.collectorKey,
            candidate.itemClass,
            plan,
            clearDeps.rulesetVersion,
          ),
        );
        rejected += 1;
        continue;
      }
      local.push(cleared.item);
      if (cleared.status === 'crossed') crossed += 1;
      else withheld += 1;
    }
    items.push(...local);
    return settle(crossed, withheld, capped, rejected);
  } catch (error) {
    deps.onSourceError?.(request.collectorKey, error instanceof Error ? error.name : 'unknown');
    const reasonCode: GapReasonCode =
      error instanceof CollectorFailure ? error.reasonCode : 'source_unreachable';
    return {
      status: reasonCode === 'timeout' ? 'timed_out' : 'unavailable',
      reasonCode,
      itemCount: 0,
      truncated: false,
    };
  }
}

function schemaRejectedGap(
  collectorKey: CollectorKey,
  itemClass: ItemClass,
  plan: CollectionPlanDirective,
  rulesetVersion: number,
): ResultItem {
  const observedAt = new Date(plan.window.to).toISOString();
  return {
    evidence: {
      kind: 'collection_gap',
      what: itemClass,
      why: 'schema_rejected',
      withheldByRedaction: false,
      collectorKey,
      reasonCode: 'schema_rejected',
      itemClass,
      observedAt,
    },
    collectorKey,
    observedAt,
    redactionDominated: false,
    redactionRulesetVersion: rulesetVersion,
  };
}

/** FR-014: what the source's answer amounts to, with the closed reason a downstream step branches on. */
function settle(crossed: number, withheld: number, capped: boolean, rejected: number): Outcome {
  const reasonCode: GapReasonCode | undefined =
    withheld > 0
      ? 'redaction_withheld'
      : rejected > 0
        ? 'schema_rejected'
        : capped
          ? 'budget_exhausted'
          : undefined;
  if (reasonCode === undefined) {
    return { status: 'collected', itemCount: crossed, truncated: false };
  }
  return {
    status: crossed === 0 && withheld > 0 ? 'withheld' : 'partial',
    reasonCode,
    itemCount: crossed,
    truncated: capped,
  };
}
