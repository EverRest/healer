import type { ControlPlaneDirective } from '@healer/boundary-contract';

/**
 * Directive idempotency (012 T051, FR-028): "a directive arrives twice → execution is idempotent
 * by directive identifier" (contracts/runner-protocol.md). This is runner-local, not
 * control-plane-tracked (QUESTIONS.md "012 phase 6") — the control plane keeps no record of what
 * a runner already executed, so the runner keeps a bounded seen-set of directive ids and refuses
 * to execute one twice.
 *
 * `ControlPlaneDirective`'s closed union (`@healer/boundary-contract`) carries no identifier field
 * on any of its seven variants — a real gap between the contract document's prose ("idempotent by
 * directive identifier") and its own schema, recorded in QUESTIONS.md rather than invented away.
 * `DirectiveEnvelope` is the runner's own transport-level wrapper for the id the contract assumes
 * exists; it is not a change to the closed schema itself.
 */
export interface DirectiveEnvelope {
  readonly id: string;
  readonly directive: ControlPlaneDirective;
}

export type DirectiveHandler = (directive: ControlPlaneDirective) => void | Promise<void>;

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

  markSeen(id: string): void {
    // Already seen: refresh its recency instead of no-op-ing, so a directive that keeps arriving
    // (redelivered while still in flight) is the last one evicted, not evicted by its own
    // re-delivery — plain FIFO would let a stale id it never learned about outlive one still
    // actively bouncing off this seen-set.
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
 * Runs each new directive's handler exactly once, in order, skipping any id already seen. Awaited
 * sequentially rather than in parallel: a real handler (T093 and beyond) will call out to the
 * runner-side agent path, and nothing about directive execution order is declared safe to
 * parallelize yet.
 */
export async function dispatchDirectives(
  directives: readonly DirectiveEnvelope[],
  seen: BoundedSeenSet,
  handle: DirectiveHandler,
): Promise<void> {
  for (const { id, directive } of directives) {
    if (seen.hasSeen(id)) continue;
    seen.markSeen(id);
    await handle(directive);
  }
}
