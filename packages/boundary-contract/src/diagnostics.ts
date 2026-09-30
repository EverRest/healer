/**
 * The support diagnostic bundle (012 T048, FR-024; `contracts/runner-protocol.md`'s Diagnostics
 * (R-06) section, verbatim: "versions, capability set, configuration with values reduced to
 * presence-only, queue depths, timing histograms, the runner's own error signatures, and the last
 * N exchanges with payloads replaced by schema identifier and size"). Lives alongside this
 * package's other runner-protocol shapes (`handshake.ts`, `runner-registration.ts`) rather than in
 * `apps/runner`: like those, it is a pure, Prisma-free shape plus a pure assembler function with no
 * process state of its own — `apps/runner`'s own `diagnostics-state.ts` owns the actual mutable
 * accumulation (the histogram, the ring buffer, the error tally) and calls `buildDiagnosticsBundle`
 * once, the same division `RunnerRegistrationSnapshot`/`findStaleRunners` already draw between a
 * pure shape and the stateful thing that produces it.
 *
 * `buildDiagnosticsBundle` never reads any I/O and never widens what it is given: every field here
 * is already reduced to a structured fact by its caller (a presence flag, a byte count, a
 * normalized signature) before it reaches this function, so there is no place inside this
 * assembler for a raw value to be smuggled through under a plausible-looking field name — the same
 * "closed shape only" posture as `index.ts`'s `RunnerEvidence` discriminated union (R-04, C-20).
 */

export type DiagnosticsConfigPresence = Readonly<Record<string, 'set' | 'default'>>;

/**
 * Fixed histogram buckets for heartbeat POST latency, in milliseconds — upper bounds, each bucket
 * counting a latency `<= ` its own bound and `>` the previous one. No metrics library: a support
 * bundle needs a coarse shape ("mostly fast, a long tail past 5s"), not percentile precision, and a
 * fixed bucket set is a handful of comparisons, not a dependency.
 */
export const HEARTBEAT_LATENCY_BUCKETS_MS = [
  50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
] as const;

export interface DiagnosticsHistogramSnapshot {
  readonly bucketsMs: readonly number[];
  readonly counts: readonly number[];
  /** Latencies past the last declared bucket — a fixed bucket set must not silently drop what it
   *  cannot classify (R-10 "fails closed" applied to a counter, not a gate, but the same posture). */
  readonly overflowCount: number;
}

export interface DiagnosticsExchange {
  readonly timestamp: string;
  /** A schema identifier, never the payload itself — `"heartbeat-request"` / `"heartbeat-response"`
   *  today; a new outbound call gets a new identifier here, not a free-form label (C-20). */
  readonly schema: string;
  readonly byteSize: number;
}

export interface DiagnosticsBundle {
  readonly generatedAt: string;
  readonly versions: {
    readonly imageVersion: string;
    readonly protocolVersion: number;
  };
  readonly capabilities: readonly string[];
  readonly configuration: DiagnosticsConfigPresence;
  readonly queueDepths: Readonly<Record<string, number>>;
  readonly heartbeatLatencyHistogramMs: DiagnosticsHistogramSnapshot;
  readonly errorSignatures: Readonly<Record<string, number>>;
  readonly recentExchanges: readonly DiagnosticsExchange[];
}

export interface DiagnosticsBundleInput {
  readonly imageVersion: string;
  readonly protocolVersion: number;
  readonly capabilities: readonly string[];
  readonly configuration: DiagnosticsConfigPresence;
  readonly queueDepths: Readonly<Record<string, number>>;
  readonly heartbeatLatencyHistogramMs: DiagnosticsHistogramSnapshot;
  readonly errorSignatures: Readonly<Record<string, number>>;
  readonly recentExchanges: readonly DiagnosticsExchange[];
  /** Injectable for deterministic tests — defaults to the real clock, same pattern as this
   *  package's other timestamped shapes take a caller-suppliable `now`. */
  readonly now?: () => Date;
}

export function buildDiagnosticsBundle(input: DiagnosticsBundleInput): DiagnosticsBundle {
  const now = input.now ?? (() => new Date());
  return {
    generatedAt: now().toISOString(),
    versions: {
      imageVersion: input.imageVersion,
      protocolVersion: input.protocolVersion,
    },
    capabilities: input.capabilities,
    configuration: input.configuration,
    queueDepths: input.queueDepths,
    heartbeatLatencyHistogramMs: input.heartbeatLatencyHistogramMs,
    errorSignatures: input.errorSignatures,
    recentExchanges: input.recentExchanges,
  };
}
