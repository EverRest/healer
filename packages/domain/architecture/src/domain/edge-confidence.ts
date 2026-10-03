import {
  assertValidObservation,
  type HumanProvenanceClass,
  type MachineProvenanceClass,
} from './edge-observation.js';
import type { ProvenanceClass } from './provenance.js';

/**
 * R-15 (FR-006): `min(100, base + observation_term - staleness_term)`, clamped at 0, every term an
 * integer — a float sum is not byte-reproducible across platforms, and a confidence that differs
 * between two machines makes a policy decision non-deterministic. Computed at write time only: it
 * is never recomputed on a schedule (a pinned query, FR-014/SC-005, could not reproduce it).
 *
 * Constants are per-tenant configuration with these starting values (tuned once discovery
 * accuracy is measured, stage 0 S0-4). `base` covers the machine classes only: the human classes
 * never reach the observation merge path (see `EdgeObservation`).
 */
export interface ConfidenceConfig {
  readonly base: Readonly<Record<MachineProvenanceClass, number>>;
  /** Points per doubling of observation volume. */
  readonly observationScale: number;
  readonly observationCap: number;
  /** Points lost per complete 30-day period since the last supporting observation. */
  readonly stalenessPerPeriod: number;
  readonly stalenessCap: number;
  /** Ceiling when volume is 1: one observation is an observation, not a fact. */
  readonly singleObservationCap: number;
}

/**
 * The human-class base values R-15's formula never reaches through the merge path (`base` above
 * is machine-only by construction) but every other write path still needs — a human confirming
 * something IS the evidence, independent of how many times a bot saw it first, so there is no
 * observation/staleness term here, only the flat starting point (004 reconciliation batch (c),
 * replacing the deleted `confidence.ts`'s `CONFIDENCE_PROVENANCE_BASE_V1` for these two classes
 * — the one surviving authority for a human base value).
 */
export const HUMAN_CONFIDENCE_BASE: Readonly<Record<HumanProvenanceClass, number>> = {
  human_confirmed: 90,
  human_authored: 85,
};

const isHumanProvenanceClass = (p: ProvenanceClass): p is HumanProvenanceClass =>
  p === 'human_confirmed' || p === 'human_authored';

/** The flat provenance-base value for ANY provenance class, human or machine — the one place that
 *  dispatches between `HUMAN_CONFIDENCE_BASE` and a (possibly tenant-overridden) `config.base`,
 *  for a caller with no observation count/recency to derive a real R-15 value from (a draft node
 *  candidate, an absence fact, a `built_from` edge). Never invents an observation; a caller that
 *  has one uses `deriveEdgeConfidence` instead. */
export function baseConfidence(
  provenance: ProvenanceClass,
  config: ConfidenceConfig = DEFAULT_CONFIDENCE_CONFIG,
): number {
  return isHumanProvenanceClass(provenance)
    ? HUMAN_CONFIDENCE_BASE[provenance]
    : config.base[provenance];
}

export const DEFAULT_CONFIDENCE_CONFIG: ConfidenceConfig = {
  base: {
    derived_from_trace: 70,
    derived_from_runtime: 65,
    derived_from_code: 60,
    derived_from_config: 50,
    inferred_from_convention: 20,
  },
  observationScale: 4,
  observationCap: 20,
  stalenessPerPeriod: 5,
  stalenessCap: 40,
  singleObservationCap: 40,
};

/** Deliberately has no `confidence` field: a model's self-report is not an input. */
export interface ConfidenceInput {
  readonly provenance: MachineProvenanceClass;
  readonly observationCount: number;
  readonly lastObservedAt: Date;
}

const DAY_MS = 86_400_000;
const PERIOD_DAYS = 30;
const clamp = (n: number) => Math.min(100, Math.max(0, n));

export function deriveEdgeConfidence(
  input: ConfidenceInput,
  now: Date,
  config: ConfidenceConfig = DEFAULT_CONFIDENCE_CONFIG,
): number {
  assertValidObservation({ ...input, observedUntil: now });
  const volume = input.observationCount;
  // floor(log2(1 + volume)) by bit length — exact integer arithmetic, no Math.log2.
  const doublings = volume >= 2 ** 31 - 1 ? 31 : 31 - Math.clz32(1 + volume);
  const observationTerm = Math.min(config.observationCap, config.observationScale * doublings);
  const idleDays = Math.max(
    0,
    Math.floor((now.getTime() - input.lastObservedAt.getTime()) / DAY_MS),
  );
  const stalenessTerm = Math.min(
    config.stalenessCap,
    config.stalenessPerPeriod * Math.floor(idleDays / PERIOD_DAYS),
  );
  const score = clamp(config.base[input.provenance] + observationTerm - stalenessTerm);
  return volume <= 1 ? Math.min(score, config.singleObservationCap) : score;
}

const SCALARS = [
  'observationScale',
  'observationCap',
  'stalenessPerPeriod',
  'stalenessCap',
  'singleObservationCap',
] as const;

const isInt0to100 = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100;

function baseOverrideOf(base: unknown): Record<string, unknown> {
  if (base === undefined) return {};
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    throw new Error('confidence `base` must be an object of provenance class to integer');
  }
  for (const [key, value] of Object.entries(base)) {
    if (!(key in DEFAULT_CONFIDENCE_CONFIG.base))
      throw new Error(`unknown provenance class: ${key}`);
    if (!isInt0to100(value)) throw new Error(`confidence base for ${key} must be an integer 0-100`);
  }
  return base as Record<string, unknown>;
}

function assertScalars(scalars: Record<string, unknown>): void {
  const known = new Set<string>(SCALARS);
  const unknownKey = Object.keys(scalars).find((k) => !known.has(k));
  if (unknownKey !== undefined) throw new Error(`unknown confidence setting: ${unknownKey}`);
  for (const key of SCALARS) {
    if (key in scalars && !isInt0to100(scalars[key])) {
      throw new Error(`${key} must be an integer 0-100`);
    }
  }
}

/**
 * A tenant's stored override (jsonb, so `unknown`) laid over the default. Anything that is not a
 * known key holding an integer 0-100 throws: a typo'd or out-of-range knob silently falling back
 * to the default would make a tenant's configuration a lie.
 */
export function resolveConfidenceConfig(override: unknown): ConfidenceConfig {
  if (override === null || override === undefined) return DEFAULT_CONFIDENCE_CONFIG;
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new Error('confidence configuration must be an object');
  }
  const { base, ...scalars } = override as Record<string, unknown>;
  assertScalars(scalars);
  const baseOverride = baseOverrideOf(base);
  return {
    ...DEFAULT_CONFIDENCE_CONFIG,
    ...(scalars as Partial<ConfidenceConfig>),
    base: {
      ...DEFAULT_CONFIDENCE_CONFIG.base,
      ...(baseOverride as Partial<ConfidenceConfig['base']>),
    },
  };
}
