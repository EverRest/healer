import type { ControlPlaneDirective, DirectiveEnvelope } from '@healer/boundary-contract';

/**
 * Directive idempotency (012 T051, FR-028): "a directive arrives twice → execution is idempotent
 * by directive identifier" (contracts/runner-protocol.md). This is runner-local, not
 * control-plane-tracked (QUESTIONS.md "012 phase 6") — the control plane keeps no record of what
 * a runner already executed, so the runner keeps a bounded seen-set of directive ids and refuses
 * to execute one twice.
 *
 * `DirectiveEnvelope` (`@healer/boundary-contract`) is the one shape both sides of the boundary
 * agree the heartbeat response's `directives` array carries — `ControlPlaneDirective`'s own seven
 * variants have no identifier field, a real gap this envelope exists to close (see that package's
 * doc comment; recorded in QUESTIONS.md, not invented away by widening the closed union).
 */
export type { DirectiveEnvelope };

export type DirectiveHandler = (directive: ControlPlaneDirective) => void | Promise<void>;

/** The minimum a logger needs to support here — not the full Pino `Logger`, so this module stays
 *  free of a `@healer/shared` dependency it otherwise has no use for. Any real Pino logger (or a
 *  test double) satisfies this structurally. */
export interface DirectiveDispatchLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * A bounded, drop-oldest membership set — deliberately not `OutboundBuffer<string>`. The two share
 * one policy (evict the oldest entry once the bound is hit) but not the operation that matters
 * here: idempotency needs `hasSeen` (a membership test), and `OutboundBuffer` has no lookup at
 * all, only `push`/`drain` for a queue that is emptied wholesale. Reusing it would mean draining
 * it somewhere just to search it — a worse fit than this dedicated, ~20-line structure.
 */
export class BoundedSeenSet {
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) throw new Error('BoundedSeenSet requires a positive maxSize');
  }

  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  /** Current occupancy — the diagnostics bundle's directive-idempotency queue depth (012 T048,
   *  `contracts/runner-protocol.md`'s Diagnostics (R-06) section). */
  get size(): number {
    return this.order.length;
  }

  /** Refreshes recency instead of no-op-ing on a re-mark, so a directive that keeps arriving
   *  (redelivered while still pending, or already executed) is the last one evicted — not evicted
   *  by the very redelivery that should keep it alive in the set. A plain FIFO seen-set, marked
   *  only the first time an id is observed, would let a bound's worth of *other* distinct ids
   *  push out an id still actively bouncing off this seen-set, and re-execute it (review finding). */
  markSeen(id: string): void {
    const existingIndex = this.order.indexOf(id);
    if (existingIndex !== -1) {
      this.order.splice(existingIndex, 1);
      this.order.push(id);
      return;
    }
    if (this.order.length >= this.maxSize) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.order.push(id);
    this.seen.add(id);
  }
}

/**
 * Runs each new directive's handler, in order, skipping any id already seen (refreshing its
 * recency on the skip, so a still-pending redelivered directive is not evicted and re-executed —
 * `BoundedSeenSet.markSeen`'s own doc comment). Awaited sequentially rather than in parallel: a
 * real handler (T093 and beyond) will call out to the runner-side agent path, and nothing about
 * directive execution order is declared safe to parallelize yet.
 *
 * A directive is marked seen only *after* its handler succeeds (FR-028 requires idempotent
 * *execution*, not idempotent *attempt* — review finding): a handler that throws leaves the id
 * eligible for retry on the next redelivery, exactly the "genuinely failed, must be retryable"
 * case idempotency-by-attempt would silently foreclose forever. Each directive's handler call is
 * wrapped in its own try/catch so one failure is logged with its id and kind and does not abort
 * the rest of the batch — a real earlier bug here let one bad directive stop every directive behind
 * it in the same heartbeat response.
 */
export async function dispatchDirectives(
  directives: readonly DirectiveEnvelope[],
  seen: BoundedSeenSet,
  handle: DirectiveHandler,
  logger: DirectiveDispatchLogger,
): Promise<void> {
  for (const { id, directive } of directives) {
    if (seen.hasSeen(id)) {
      seen.markSeen(id);
      continue;
    }
    try {
      await handle(directive);
      seen.markSeen(id);
    } catch (error) {
      logger.error(
        {
          directiveId: id,
          directiveKind: directive.kind,
          err: error instanceof Error ? error.message : String(error),
        },
        'directive handler failed — not marked seen, eligible for retry on redelivery',
      );
    }
  }
}
