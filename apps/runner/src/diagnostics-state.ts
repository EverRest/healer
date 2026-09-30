import {
  HEARTBEAT_LATENCY_BUCKETS_MS,
  type DiagnosticsExchange,
  type DiagnosticsHistogramSnapshot,
} from '@healer/boundary-contract';
import { normalizeHeartbeatErrorSignature } from './heartbeat-client.js';

/**
 * Runner-local, in-process accumulation for the support diagnostic bundle (012 T048, FR-024).
 * Deliberately *not* in `@healer/boundary-contract` alongside `buildDiagnosticsBundle`: that
 * function and its types are a pure shape with no state; this class is the mutable thing that
 * feeds it — a heartbeat latency histogram, a bounded error-signature tally and a bounded ring
 * buffer of recent exchanges, all scoped to one running runner process, same as `BoundedSeenSet`
 * (`directive-dispatcher.ts`) is scoped to one process's directive idempotency.
 */

/** Bound for `recentExchanges` — "the last N exchanges" (R-06). A placeholder, same status as
 *  every other un-measured bound in this codebase (`RUNNER_DIRECTIVE_SEEN_SET_SIZE` and friends):
 *  no real fleet exists yet to measure a useful support window against. Counts individual
 *  exchanges (a request and its response are two entries), not heartbeat cycles. */
export const MAX_RECENT_EXCHANGES = 20;

/** A small, dedicated drop-oldest ring buffer — `BoundedSeenSet` doesn't fit here: it is a
 *  membership set with no ordered value storage, and this needs to keep the values themselves
 *  (timestamp, schema, byteSize), not just know an id was seen. Same policy as `OutboundBuffer`
 *  and `BoundedSeenSet` (evict the oldest once bounded), a third small structure rather than a
 *  forced reuse of either — the same judgment call precedent as T051's own seen-set. */
class BoundedRingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) throw new Error('BoundedRingBuffer requires a positive maxSize');
  }

  push(item: T): void {
    if (this.items.length >= this.maxSize) this.items.shift();
    this.items.push(item);
  }

  toArray(): readonly T[] {
    return [...this.items];
  }
}

class LatencyHistogram {
  private readonly counts: number[] = HEARTBEAT_LATENCY_BUCKETS_MS.map(() => 0);
  private overflowCount = 0;

  record(latencyMs: number): void {
    const bucketIndex = HEARTBEAT_LATENCY_BUCKETS_MS.findIndex((bound) => latencyMs <= bound);
    if (bucketIndex === -1) {
      this.overflowCount += 1;
      return;
    }
    this.counts[bucketIndex] = (this.counts[bucketIndex] ?? 0) + 1;
  }

  snapshot(): DiagnosticsHistogramSnapshot {
    return {
      bucketsMs: HEARTBEAT_LATENCY_BUCKETS_MS,
      counts: [...this.counts],
      overflowCount: this.overflowCount,
    };
  }
}

export interface DiagnosticsStateSnapshot {
  readonly heartbeatLatencyHistogramMs: DiagnosticsHistogramSnapshot;
  readonly errorSignatures: Readonly<Record<string, number>>;
  readonly recentExchanges: readonly DiagnosticsExchange[];
}

export class DiagnosticsState {
  private readonly latency = new LatencyHistogram();
  private readonly errorTally = new Map<string, number>();
  private readonly exchanges = new BoundedRingBuffer<DiagnosticsExchange>(MAX_RECENT_EXCHANGES);

  private pushExchange(schema: string, byteSize: number): void {
    this.exchanges.push({ timestamp: new Date().toISOString(), schema, byteSize });
  }

  /** A heartbeat POST that completed with a validated response — records latency and both sides
   *  of the exchange as schema identifier + byte size, never the payload itself. */
  recordHeartbeatSuccess(latencyMs: number, requestBytes: number, responseBytes: number): void {
    this.latency.record(latencyMs);
    this.pushExchange('heartbeat-request', requestBytes);
    this.pushExchange('heartbeat-response', responseBytes);
  }

  /** A heartbeat POST that failed — no response was ever received, so only the request side of
   *  the exchange is recorded; the failure itself is tallied by normalized signature, never by
   *  the original error's message (`normalizeHeartbeatErrorSignature`'s own doc comment). */
  recordHeartbeatFailure(latencyMs: number, requestBytes: number, error: unknown): void {
    this.latency.record(latencyMs);
    this.pushExchange('heartbeat-request', requestBytes);
    const signature = normalizeHeartbeatErrorSignature(error);
    this.errorTally.set(signature, (this.errorTally.get(signature) ?? 0) + 1);
  }

  snapshot(): DiagnosticsStateSnapshot {
    return {
      heartbeatLatencyHistogramMs: this.latency.snapshot(),
      errorSignatures: Object.fromEntries(this.errorTally),
      recentExchanges: this.exchanges.toArray(),
    };
  }
}
