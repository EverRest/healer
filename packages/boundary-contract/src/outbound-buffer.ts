/**
 * Bounded outbound buffering (012 T046, FR-021, runner-protocol.md "Failure behaviour").
 *
 * When the control plane is unreachable, the runner buffers rather than blocking the customer's
 * systems. The buffer is lossy **with a record**, deliberately weaker than control-plane
 * ingestion durability: an unbounded buffer would eventually exhaust the customer's memory, so
 * the honest outcome at the bound is a visible gap, not a promise of no loss. On overflow the
 * oldest item is dropped, not the newest — the newest carries the freshest signal.
 *
 * The gap log itself is bounded the same way: a sustained outage overflows `items` on every push,
 * and an unbounded `gaps` array would just move the memory-exhaustion risk it exists to record.
 * Overflowing `gaps` drops the oldest gap record, same policy as `items` — the record of a gap
 * getting silently lost is itself a further gap, but that trade is only reachable once loss is
 * already this deep into the buffer's failure mode.
 */
export interface CollectionGap {
  readonly kind: 'collection_gap';
  readonly what: string;
  readonly why: string;
  readonly withheldByRedaction: boolean;
}

export class OutboundBuffer<T> {
  private readonly items: T[] = [];
  private readonly gaps: CollectionGap[] = [];

  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) throw new Error('OutboundBuffer requires a positive maxSize');
  }

  push(item: T, describe: (dropped: T) => string): void {
    if (this.items.length >= this.maxSize) {
      const dropped = this.items.shift();
      if (dropped !== undefined) {
        if (this.gaps.length >= this.maxSize) this.gaps.shift();
        this.gaps.push({
          kind: 'collection_gap',
          what: describe(dropped),
          why: 'outbound buffer overflow — control plane unreachable past the bound',
          withheldByRedaction: false,
        });
      }
    }
    this.items.push(item);
  }

  drain(): T[] {
    return this.items.splice(0, this.items.length);
  }

  drainGaps(): CollectionGap[] {
    return this.gaps.splice(0, this.gaps.length);
  }

  get size(): number {
    return this.items.length;
  }
}
